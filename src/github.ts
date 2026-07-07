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

async function githubRequest(token: string, method: string, path: string): Promise<unknown> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': 'runner-autoscaler',
    },
  });
  if (!res.ok) throw new Error(`GitHub API ${method} ${path} failed: ${res.status} ${res.statusText}`);
  return res.json();
}

/**
 * Generate a just-in-time runner config for one job. The runner registered
 * with it is inherently ephemeral: it runs at most one job and is removed
 * from the repo by GitHub afterwards. No GitHub credential ever reaches the
 * VM — only this opaque, single-use config blob does.
 */
export async function generateJitConfig(config: Config, repo: string, runnerName: string): Promise<string> {
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
  if (!res.ok) throw new Error(`generate-jitconfig for ${repo} failed: ${res.status} ${res.statusText}`);
  const data = (await res.json()) as { encoded_jit_config: string };
  return data.encoded_jit_config;
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

export type QueuedJob = { id: number; labels: string[] };

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
    )) as { jobs: Array<{ id: number; status: string; labels: string[] }> };
    for (const job of runJobs.jobs) {
      if (job.status === 'queued') jobs.push({ id: job.id, labels: job.labels });
    }
  }
  return jobs;
}
