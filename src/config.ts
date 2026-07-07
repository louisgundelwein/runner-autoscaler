// ponytail: manual env parsing — a validation library would be a dependency
// for a dozen required() calls.

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function integer(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`${name} must be a positive integer, got "${raw}"`);
  return n;
}

export function parseRepos(raw: string): Set<string> {
  const repos = new Set(
    raw
      .split(',')
      .map((r) => r.trim().toLowerCase())
      .filter(Boolean),
  );
  if (repos.size === 0) throw new Error('GITHUB_REPOS must list at least one owner/repo');
  for (const repo of repos) {
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) {
      throw new Error(`GITHUB_REPOS entries must be "owner/repo", got "${repo}"`);
    }
  }
  return repos;
}

export function loadConfig() {
  return {
    webhookSecret: required('GITHUB_WEBHOOK_SECRET'),
    githubToken: required('GITHUB_TOKEN'),
    repos: parseRepos(required('GITHUB_REPOS')),
    hcloudToken: required('HCLOUD_TOKEN'),
    serverType: process.env.HETZNER_SERVER_TYPE || 'cx33',
    image: process.env.HETZNER_IMAGE || 'ubuntu-24.04',
    location: process.env.HETZNER_LOCATION || 'nbg1',
    sshKey: process.env.HETZNER_SSH_KEY || undefined,
    runnerLabels: (process.env.RUNNER_LABELS || 'self-hosted,hetzner')
      .split(',')
      .map((l) => l.trim())
      .filter(Boolean),
    maxRunners: integer('MAX_RUNNERS', 3),
    maxRunnerLifetimeMinutes: integer('MAX_RUNNER_LIFETIME_MINUTES', 120),
    cleanupIntervalMinutes: integer('CLEANUP_INTERVAL_MINUTES', 15),
    port: integer('PORT', 8080),
  };
}

export type Config = ReturnType<typeof loadConfig>;
