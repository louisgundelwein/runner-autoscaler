import { createServer } from 'node:http';
import { loadConfig } from './config.ts';
import { log } from './log.ts';
import {
  generateJitConfig,
  labelsMatch,
  latestRunnerVersion,
  listQueuedJobs,
  openFailureIssueOnce,
  serverNameForJob,
  setFailureStatus,
  verifySignature,
} from './github.ts';
import {
  createRunnerServer,
  deleteServerById,
  deleteServerByName,
  isExpired,
  listRunnerServers,
} from './hetzner.ts';
import { buildUserData } from './cloud-init.ts';

const config = loadConfig();

// Jobs currently being provisioned in this process; first line of dedup.
// Across restarts, Hetzner's per-project name uniqueness is the guarantee.
const inFlight = new Set<number>();

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

async function provisionRunner(repo: string, jobId: number): Promise<void> {
  if (inFlight.has(jobId)) return;
  inFlight.add(jobId);
  try {
    const name = serverNameForJob(jobId);
    const servers = await listRunnerServers(config);
    if (servers.some((s) => s.name === name)) return;
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
    const [version, jitConfig] = await Promise.all([
      latestRunnerVersion(),
      generateJitConfig(config, repo, name),
    ]);
    const result = await createRunnerServer(config, name, repo, buildUserData(version, jitConfig));
    failureCounts.set(repo, 0);
    log('info', result === 'created' ? 'runner VM created' : 'runner VM already existed', {
      jobId,
      repo,
      name,
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
    provisionRunner(repo, job.id).catch((err) =>
      reportProvisioningFailure(repo, job.id, job.head_sha, err),
    );
  } else if (payload.action === 'completed') {
    deleteServerByName(config, serverNameForJob(job.id)).catch((err) =>
      log('error', 'deletion failed, cleanup sweep will retry', { jobId: job.id, error: String(err) }),
    );
  }
  // in_progress / waiting need no action
}

/**
 * Safety net, runs every CLEANUP_INTERVAL_MINUTES:
 * 1. Delete managed VMs older than MAX_RUNNER_LIFETIME_MINUTES — catches
 *    crashed jobs, missed webhooks and anything else. This is the hard
 *    guarantee that no VM keeps billing unnoticed.
 * 2. Reconcile: provision runners for still-queued jobs that have no VM
 *    (missed webhooks during redeploys, jobs skipped at the runner cap).
 */
async function cleanupTick(): Promise<void> {
  const servers = await listRunnerServers(config);
  for (const server of servers) {
    if (isExpired(server.created, config.maxRunnerLifetimeMinutes)) {
      log('warn', 'deleting runner VM past max lifetime', { name: server.name, created: server.created });
      await deleteServerById(config, server.id, server.name);
    }
  }
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

const runCleanup = () =>
  cleanupTick().catch((err) => log('error', 'cleanup tick failed', { error: String(err) }));
const cleanupTimer = setInterval(runCleanup, config.cleanupIntervalMinutes * 60_000);
setTimeout(runCleanup, 15_000); // heal missed events shortly after (re)deploys

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    log('info', 'shutting down', { signal });
    clearInterval(cleanupTimer);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5_000).unref();
  });
}
