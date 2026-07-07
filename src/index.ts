import { createServer } from 'node:http';
import * as http from 'node:http';
import { loadConfig } from './config.ts';
import { log } from './log.ts';
import {
  generateJitConfig,
  getJobStatus,
  labelsMatch,
  latestRunnerVersion,
  listQueuedJobs,
  openFailureIssueOnce,
  serverNameForJob,
  setFailureStatus,
  verifySignature,
  vmToken,
  verifyVmToken,
  listRunners,
  deleteRunnerById,
  shouldDrain,
} from './github.ts';
import {
  createRunnerServer,
  deleteServerById,
  isExpired,
  listRunnerServers,
} from './hetzner.ts';
import { buildUserData } from './cloud-init.ts';

const config = loadConfig();

// Jobs currently being provisioned in this process; first line of dedup.
// Across restarts, Hetzner's per-project name uniqueness is the guarantee.
const inFlight = new Set<number>();

// Per-VM counter for generating unique runner names (e.g. ci-runner-12345-r0, r1, r2...)
// Falls back to timestamp-based suffix after restart so names stay unique.
const runnerCounters = new Map<string, number>();

// Consecutive provisioning failures per repo; at the threshold an issue is
// opened on the repo (deduped there via label). Reset on the next success.
const failureCounts = new Map<string, number>();
const OPEN_ISSUE_AFTER = 3;

async function reportProvisioningFailure(
  repo: string,
  jobId: number,
  headSha: string | undefined,
  err: unknown,
): Promise<void> {
  const message = String(err);
  const count = (failureCounts.get(repo) ?? 0) + 1;
  failureCounts.set(repo, count);
  log('error', 'provisioning failed', { jobId, repo, consecutiveFailures: count, error: message });
  if (headSha) {
    await setFailureStatus(config, repo, headSha, message).catch((e) =>
      log('error', 'could not set commit status (PAT permission "Commit statuses: RW"?)', { error: String(e) }),
    );
  }
  if (count >= OPEN_ISSUE_AFTER) {
    await openFailureIssueOnce(config, repo, message).catch((e) =>
      log('error', 'could not open failure issue (PAT permission "Issues: RW"?)', { error: String(e) }),
    );
  }
}

async function provisionRunner(repo: string, jobId: number, recheck = false): Promise<void> {
  if (inFlight.has(jobId)) return;
  inFlight.add(jobId);
  try {
    if (recheck) {
      // The queued webhook races GitHub's own assignment to an idle reused
      // runner: by the time we see the event, the job may already be running
      // there. Wait briefly and re-check before paying for a VM.
      await new Promise((r) => setTimeout(r, 10_000));
      const status = await getJobStatus(config, repo, jobId).catch(() => 'queued');
      if (status !== 'queued') {
        log('info', 'job already picked up, skipping provisioning', { jobId, repo, status });
        return;
      }
    }
    const servers = await listRunnerServers(config);
    // ponytail: cap check is approximate under concurrency — Hetzner name
    // uniqueness prevents duplicates, and the reconcile pass picks up jobs
    // skipped here once capacity frees up.
    if (servers.length + inFlight.size - 1 >= config.maxRunners) {
      log('warn', 'runner cap reached, leaving job queued for reconcile', {
        jobId,
        repo,
        cap: config.maxRunners,
      });
      return;
    }

    // Check if any online, non-busy runner with our labels already exists.
    const allRunners = await listRunners(config, repo);
    const availableRunner = allRunners.find(
      (r) => r.status === 'online' && !r.busy && config.runnerLabels.every((l) => r.labels.includes(l)),
    );
    if (availableRunner) {
      log('info', 'runner already online and available, GitHub will assign', {
        jobId,
        repo,
        runnerId: availableRunner.id,
      });
      return;
    }

    const vmName = serverNameForJob(jobId);
    if (servers.some((s) => s.name === vmName)) return;

    const [version, jitConfig] = await Promise.all([
      latestRunnerVersion(),
      generateJitConfig(config, repo, vmName),
    ]);
    const token = vmToken(config.webhookSecret, vmName);
    const result = await createRunnerServer(
      config,
      vmName,
      repo,
      buildUserData(version, jitConfig, vmName, token, config.publicUrl),
    );
    failureCounts.set(repo, 0);
    log('info', result === 'created' ? 'runner VM created' : 'runner VM already existed', {
      jobId,
      repo,
      name: vmName,
      runnerVersion: version,
    });
  } finally {
    inFlight.delete(jobId);
  }
}

type WorkflowJobEvent = {
  action: string;
  workflow_job?: { id: number; labels: string[]; head_sha?: string };
  repository?: { full_name: string };
};

function handleWorkflowJobEvent(payload: WorkflowJobEvent): void {
  const job = payload.workflow_job;
  const repo = payload.repository?.full_name?.toLowerCase();
  if (!job || !repo) return;

  if (payload.action === 'queued') {
    if (!config.repos.has(repo)) {
      log('info', 'ignoring job from repo not in allowlist', { repo, jobId: job.id });
      return;
    }
    if (!labelsMatch(job.labels, config.runnerLabels)) return;
    provisionRunner(repo, job.id, true).catch((err) =>
      reportProvisioningFailure(repo, job.id, job.head_sha, err),
    );
  }
  // completed: don't delete here — the VM stays alive for the next job in its billed hour.
  // The cleanup sweep (poolTick) handles drain-window deletion.
  // in_progress / waiting need no action
}

/**
 * Safety net, runs every CLEANUP_INTERVAL_MINUTES:
 * 1. Delete managed VMs past max lifetime — hard cap.
 * 2. Drain VMs in the drain window (min 50+ of each billed hour) if no online runners.
 * 3. Self-heal: delete VMs with no online/busy runners after 12+ minutes.
 * 4. Reconcile: provision runners for still-queued jobs.
 */
async function poolTick(): Promise<void> {
  const servers = await listRunnerServers(config);
  const now = Date.now();

  for (const server of servers) {
    if (isExpired(server.created, config.maxRunnerLifetimeMinutes)) {
      log('warn', 'deleting runner VM past max lifetime', { name: server.name, created: server.created });
      await deleteServerById(config, server.id, server.name);
      continue;
    }

    const aliveMinutes = (now - Date.parse(server.created)) / 60_000;

    // Drain window: minute 50+ of the billed hour. A healthy reused VM sits
    // here with an idle ONLINE runner listening — that is exactly what we
    // deregister (GitHub stops assigning after the DELETE) and then remove
    // the VM. Only a BUSY runner (job in flight) defers to the next tick.
    if (aliveMinutes % 60 >= 50) {
      let hasBusyRunner = false;
      for (const repo of config.repos) {
        const runners = await listRunners(config, repo);
        const vmRunners = runners.filter(
          (r) => r.name === server.name || r.name.startsWith(server.name + '-r'),
        );
        if (vmRunners.some((r) => r.busy)) hasBusyRunner = true;
      }

      if (!hasBusyRunner) {
        log('info', 'draining runner VM at hour boundary', {
          name: server.name,
          aliveMinutes,
        });
        let allDeletionsSucceeded = true;
        for (const repo of config.repos) {
          const runners = await listRunners(config, repo);
          const vmRunners = runners.filter(
            (r) => r.name === server.name || r.name.startsWith(server.name + '-r'),
          );
          for (const runner of vmRunners) {
            const status = await deleteRunnerById(config, repo, runner.id);
            if (status !== 204 && status !== 404) {
              allDeletionsSucceeded = false;
              log('warn', 'failed to delete runner, will retry next tick', {
                repo,
                runnerId: runner.id,
                status,
              });
            }
          }
        }

        if (allDeletionsSucceeded) {
          await deleteServerById(config, server.id, server.name);
        }
      }
      continue;
    }

    // Self-heal: if VM is alive >= 12 min and has no online/busy runners, it likely
    // never came online (dead networking). Delete and let reconcile reprovision.
    if (aliveMinutes >= 12) {
      let hasAnyOnlineOrBusy = false;
      for (const repo of config.repos) {
        const runners = await listRunners(config, repo);
        const vmRunners = runners.filter(
          (r) => r.name === server.name || r.name.startsWith(server.name + '-r'),
        );
        for (const runner of vmRunners) {
          if ((runner.status === 'online' && !runner.busy) || (runner.status === 'online' && runner.busy)) {
            hasAnyOnlineOrBusy = true;
          }
        }
      }

      if (!hasAnyOnlineOrBusy) {
        log('info', 'replacing never-online runner VM', { name: server.name, aliveMinutes });
        for (const repo of config.repos) {
          const runners = await listRunners(config, repo);
          const vmRunners = runners.filter(
            (r) => r.name === server.name || r.name.startsWith(server.name + '-r'),
          );
          for (const runner of vmRunners) {
            await deleteRunnerById(config, repo, runner.id).catch((err) =>
              log('warn', 'failed to delete offline runner during self-heal', {
                repo,
                runnerId: runner.id,
                error: String(err),
              }),
            );
          }
        }
        await deleteServerById(config, server.id, server.name);
      }
    }
  }

  // Reconcile: provision runners for still-queued jobs.
  for (const repo of config.repos) {
    const jobs = await listQueuedJobs(config, repo);
    for (const job of jobs) {
      if (labelsMatch(job.labels, config.runnerLabels)) {
        await provisionRunner(repo, job.id).catch((err) =>
          reportProvisioningFailure(repo, job.id, job.head_sha, err),
        );
      }
    }
  }
}

async function handleNextRunner(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  if (req.method !== 'POST') {
    res.writeHead(405);
    res.end();
    return;
  }

  const chunks: Buffer[] = [];
  let size = 0;
  req.on('data', (chunk: Buffer) => {
    size += chunk.length;
    if (size > 1024) req.destroy(); // next-runner payloads are ~30 bytes + jitconfig base64
    else chunks.push(chunk);
  });
  req.on('end', async () => {
    try {
      const body = Buffer.concat(chunks);
      let payload: { vmName?: string; token?: string };
      try {
        payload = JSON.parse(body.toString('utf8'));
      } catch {
        res.writeHead(400);
        res.end();
        return;
      }

      const { vmName, token } = payload;
      if (!vmName || !token) {
        res.writeHead(400);
        res.end();
        return;
      }

      // Verify token with timing-safe comparison.
      if (!verifyVmToken(config.webhookSecret, vmName, token)) {
        log('warn', 'rejected next-runner request with invalid token', { vmName });
        res.writeHead(401);
        res.end();
        return;
      }

      // Verify VM exists and is managed.
      const servers = await listRunnerServers(config);
      const server = servers.find((s) => s.name === vmName);
      if (!server) {
        log('warn', 'next-runner VM not found or not managed', { vmName });
        res.writeHead(404);
        res.end();
        return;
      }

      const aliveMinutes = (Date.now() - Date.parse(server.created)) / 60_000;

      // Check drain condition.
      let hasQueuedJobs = false;
      for (const repo of config.repos) {
        const jobs = await listQueuedJobs(config, repo);
        const matching = jobs.filter((j) => labelsMatch(j.labels, config.runnerLabels));
        if (matching.length > 0) {
          hasQueuedJobs = true;
          break;
        }
      }

      if (shouldDrain(aliveMinutes, hasQueuedJobs)) {
        log('info', 'VM in drain window with nothing queued, signaling exit', { vmName, aliveMinutes });
        res.writeHead(204);
        res.end();
        return;
      }

      // Not draining: always hand out a fresh jitconfig so the VM keeps an
      // idle runner listening — that idle registration is what lets GitHub
      // assign the next push instantly instead of booting a new VM. Prefer
      // the repo with a queued job; otherwise register on the first repo.
      // ponytail: with multiple allowlisted repos an idle runner only serves
      // one of them — revisit with per-repo pools if that ever matters.
      let targetRepo = [...config.repos][0]!;
      for (const repo of config.repos) {
        const jobs = await listQueuedJobs(config, repo);
        if (jobs.some((j) => labelsMatch(j.labels, config.runnerLabels))) {
          targetRepo = repo;
          break;
        }
      }

      const counter = (runnerCounters.get(vmName) ?? 0) + 1;
      runnerCounters.set(vmName, counter);
      const runnerName = `${vmName}-r${counter}`;

      try {
        const jitConfig = await generateJitConfig(config, targetRepo, runnerName);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ jitconfig: jitConfig }));
        log('info', 'issued fresh jitconfig', { vmName, runnerName, repo: targetRepo, hasQueuedJobs });
      } catch (err) {
        log('error', 'failed to generate jitconfig', { vmName, repo: targetRepo, error: String(err) });
        res.writeHead(500);
        res.end();
      }
    } catch (err) {
      log('error', 'next-runner handler error', { error: String(err) });
      res.writeHead(500);
      res.end();
    }
  });
}

const server = createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
    return;
  }

  if (req.method === 'POST' && req.url === '/webhook') {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > 1_048_576) req.destroy(); // webhook payloads are ~10 KiB
      else chunks.push(chunk);
    });
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const signature = req.headers['x-hub-signature-256'];
      if (!verifySignature(config.webhookSecret, body, typeof signature === 'string' ? signature : undefined)) {
        log('warn', 'rejected webhook with invalid signature');
        res.writeHead(401);
        res.end();
        return;
      }
      if (req.headers['x-github-event'] !== 'workflow_job') {
        res.writeHead(204);
        res.end();
        return;
      }
      let payload: WorkflowJobEvent;
      try {
        payload = JSON.parse(body.toString('utf8'));
      } catch {
        res.writeHead(400);
        res.end();
        return;
      }
      // Respond before doing any work so GitHub's 10s webhook timeout never hits.
      res.writeHead(202);
      res.end();
      handleWorkflowJobEvent(payload);
    });
    return;
  }

  if (req.method === 'POST' && req.url === '/next-runner') {
    handleNextRunner(req, res).catch((err) =>
      log('error', 'unhandled error in next-runner handler', { error: String(err) }),
    );
    return;
  }

  res.writeHead(404);
  res.end();
});

server.listen(config.port, () => {
  log('info', 'autoscaler listening', {
    port: config.port,
    repos: [...config.repos],
    runnerLabels: config.runnerLabels,
    serverType: config.serverType,
    location: config.location,
    maxRunners: config.maxRunners,
    maxRunnerLifetimeMinutes: config.maxRunnerLifetimeMinutes,
  });
});

const runPoolTick = () =>
  poolTick().catch((err) => log('error', 'pool tick failed', { error: String(err) }));
const poolTimer = setInterval(runPoolTick, config.cleanupIntervalMinutes * 60_000);
setTimeout(runPoolTick, 15_000); // heal missed events shortly after (re)deploys

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    log('info', 'shutting down', { signal });
    clearInterval(poolTimer);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5_000).unref();
  });
}
