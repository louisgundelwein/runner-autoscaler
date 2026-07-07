import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Config } from './config.ts';

const API = 'https://api.github.com';

/** Verify the X-Hub-Signature-256 header (HMAC-SHA256 over the raw body). */
export function verifySignature(secret: string, body: Buffer, signatureHeader: string | undefined): boolean {
  if (!signatureHeader?.startsWith('sha256=')) return false;
  const expected = createHmac('sha256', secret).update(body).digest('hex');
  const received = signatureHeader.slice('sha256='.length);
  if (received.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(received), Buffer.from(expected));
}

/**
 * A job is ours when every label it requests is one of our runner labels
 * (GitHub assigns a job to a runner iff the job's runs-on labels are a
 * subset of the runner's labels). Jobs like ["ubuntu-latest"] never match.
 */
export function labelsMatch(jobLabels: string[], runnerLabels: string[]): boolean {
  if (jobLabels.length === 0) return false;
  return jobLabels.every((label) => runnerLabels.includes(label));
}

export function serverNameForJob(jobId: number): string {
  return `ci-runner-${jobId}`;
}

async function githubRequest(token: string, method: string, path: string, body?: unknown): Promise<unknown> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': 'runner-autoscaler',
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`GitHub API ${method} ${path} failed: ${res.status} ${res.statusText}`);
  return res.json();
}

const STATUS_CONTEXT = 'runner-autoscaler';

/**
 * Surface a provisioning failure directly on the commit/PR as an error
 * status — otherwise the job just sits "queued" with no visible reason.
 * Requires PAT permission "Commit statuses: read & write".
 */
export async function setFailureStatus(config: Config, repo: string, sha: string, message: string): Promise<void> {
  await githubRequest(config.githubToken, 'POST', `/repos/${repo}/statuses/${sha}`, {
    state: 'error',
    context: STATUS_CONTEXT,
    description: message.slice(0, 140),
  });
}

/**
 * Escalation: open one issue when provisioning keeps failing. Deduped via
 * the runner-autoscaler label — while such an issue is open, no new one is
 * created. Requires PAT permission "Issues: read & write".
 */
export async function openFailureIssueOnce(config: Config, repo: string, message: string): Promise<void> {
  const open = (await githubRequest(
    config.githubToken,
    'GET',
    `/repos/${repo}/issues?state=open&labels=${STATUS_CONTEXT}&per_page=1`,
  )) as unknown[];
  if (open.length > 0) return;
  await githubRequest(config.githubToken, 'POST', `/repos/${repo}/issues`, {
    title: 'runner-autoscaler: provisioning is failing repeatedly',
    labels: [STATUS_CONTEXT],
    body: [
      'The runner autoscaler failed to provision ephemeral runners several times in a row.',
      '',
      `Last error: \`${message.slice(0, 500)}\``,
      '',
      'Jobs targeting `[self-hosted, hetzner]` will stay queued until this is fixed.',
      'Check the autoscaler service logs for details. This issue was opened automatically;',
      'close it once provisioning works again.',
    ].join('\n'),
  });
}

/**
 * Generate a just-in-time runner config for one job. The runner registered
 * with it is inherently ephemeral: it runs at most one job and is removed
 * from the repo by GitHub afterwards. No GitHub credential ever reaches the
 * VM — only this opaque, single-use config blob does.
 *
 * Generating the config already registers the runner name on GitHub's side.
 * If a previous attempt registered the name but the VM was never created
 * (e.g. the Hetzner call failed), the retry gets a 409 Conflict — in that
 * case we delete the orphaned offline runner and try once more.
 */
export async function generateJitConfig(config: Config, repo: string, runnerName: string): Promise<string> {
  const first = await requestJitConfig(config, repo, runnerName);
  if (first.status !== 409) return unwrapJitConfig(first, repo);

  await deleteOfflineRunnerByName(config, repo, runnerName);
  return unwrapJitConfig(await requestJitConfig(config, repo, runnerName), repo);
}

async function requestJitConfig(
  config: Config,
  repo: string,
  runnerName: string,
): Promise<{ status: number; data: any }> {
  const res = await fetch(`${API}/repos/${repo}/actions/runners/generate-jitconfig`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${config.githubToken}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': 'runner-autoscaler',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ name: runnerName, runner_group_id: 1, labels: config.runnerLabels }),
  });
  return { status: res.status, data: res.ok ? await res.json() : null };
}

function unwrapJitConfig(res: { status: number; data: any }, repo: string): string {
  if (!res.data?.encoded_jit_config) throw new Error(`generate-jitconfig for ${repo} failed: ${res.status}`);
  return res.data.encoded_jit_config;
}

/** Remove a runner registration that never came online (safety: never deletes online runners). */
async function deleteOfflineRunnerByName(config: Config, repo: string, runnerName: string): Promise<void> {
  const runners = (await githubRequest(
    config.githubToken,
    'GET',
    `/repos/${repo}/actions/runners?per_page=100`,
  )) as { runners: Array<{ id: number; name: string; status: string }> };
  const orphan = runners.runners.find((r) => r.name === runnerName && r.status === 'offline');
  if (!orphan) return;
  const res = await fetch(`${API}/repos/${repo}/actions/runners/${orphan.id}`, {
    method: 'DELETE',
    headers: {
      authorization: `Bearer ${config.githubToken}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': 'runner-autoscaler',
    },
  });
  if (res.status !== 204) throw new Error(`Deleting orphaned runner ${runnerName} failed: ${res.status}`);
}

let cachedRunnerVersion: { version: string; fetchedAt: number } | null = null;

/** Resolve the latest actions/runner version via the releases/latest redirect (no API rate limit). */
export async function latestRunnerVersion(): Promise<string> {
  if (cachedRunnerVersion && Date.now() - cachedRunnerVersion.fetchedAt < 3_600_000) {
    return cachedRunnerVersion.version;
  }
  const res = await fetch('https://github.com/actions/runner/releases/latest', { redirect: 'manual' });
  const location = res.headers.get('location') ?? '';
  const version = location.match(/\/tag\/v([\d.]+)$/)?.[1];
  if (!version) throw new Error(`Could not resolve latest runner version from redirect: ${location || res.status}`);
  cachedRunnerVersion = { version, fetchedAt: Date.now() };
  return version;
}

export type QueuedJob = { id: number; labels: string[]; head_sha: string };

/**
 * List queued workflow jobs for a repo. Used by the reconcile pass to heal
 * missed webhooks (e.g. while the autoscaler was redeploying) and jobs that
 * were skipped because the runner cap was reached.
 * Requires the PAT to have "Actions: read" on the repo.
 */
export async function listQueuedJobs(config: Config, repo: string): Promise<QueuedJob[]> {
  const runs = (await githubRequest(
    config.githubToken,
    'GET',
    `/repos/${repo}/actions/runs?status=queued&per_page=20`,
  )) as { workflow_runs: Array<{ id: number }> };

  const jobs: QueuedJob[] = [];
  for (const run of runs.workflow_runs) {
    const runJobs = (await githubRequest(
      config.githubToken,
      'GET',
      `/repos/${repo}/actions/runs/${run.id}/jobs?per_page=100`,
    )) as { jobs: Array<{ id: number; status: string; labels: string[]; head_sha: string }> };
    for (const job of runJobs.jobs) {
      if (job.status === 'queued') jobs.push({ id: job.id, labels: job.labels, head_sha: job.head_sha });
    }
  }
  return jobs;
}
