import type { Config } from './config.ts';
import { log } from './log.ts';

const API = 'https://api.hetzner.cloud/v1';
export const MANAGED_LABEL_KEY = 'managed-by';
export const MANAGED_LABEL_VALUE = 'runner-autoscaler';
const MANAGED_SELECTOR = `${MANAGED_LABEL_KEY}=${MANAGED_LABEL_VALUE}`;

export type RunnerServer = { id: number; name: string; created: string };

/** True when the server's created timestamp is older than the allowed lifetime. */
export function isExpired(createdIso: string, lifetimeMinutes: number, nowMs = Date.now()): boolean {
  return nowMs - Date.parse(createdIso) > lifetimeMinutes * 60_000;
}

async function hcloudRequest(
  token: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; data: any }> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
    try {
      const res = await fetch(`${API}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          ...(body ? { 'content-type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
      // Retry only transient failures; 4xx (except 429) are final.
      if (res.status === 429 || res.status >= 500) {
        lastError = new Error(`Hetzner API ${method} ${path}: ${res.status}`);
        continue;
      }
      const data = res.status === 204 ? null : await res.json().catch(() => null);
      return { status: res.status, data };
    } catch (err) {
      lastError = err; // network error
    }
  }
  throw lastError;
}

/**
 * Create a runner VM. Server names are unique per Hetzner project, so a
 * duplicate webhook delivery gets a 409 uniqueness_error — which we treat
 * as success. That is the idempotency guarantee across process restarts.
 */
export async function createRunnerServer(
  config: Config,
  name: string,
  repo: string,
  userData: string,
): Promise<'created' | 'exists'> {
  const { status, data } = await hcloudRequest(config.hcloudToken, 'POST', '/servers', {
    name,
    server_type: config.serverType,
    image: config.image,
    location: config.location,
    user_data: userData,
    labels: {
      [MANAGED_LABEL_KEY]: MANAGED_LABEL_VALUE,
      // Label values must not contain "/".
      repo: repo.replace('/', '-').slice(0, 63),
    },
    ...(config.sshKey ? { ssh_keys: [config.sshKey] } : {}),
    public_net: { enable_ipv4: true, enable_ipv6: true },
  });
  if (status === 201) return 'created';
  if (status === 409 && data?.error?.code === 'uniqueness_error') return 'exists';
  throw new Error(`Hetzner server create failed: ${status} ${data?.error?.code ?? ''} ${data?.error?.message ?? ''}`);
}

/** All servers this autoscaler manages (selected by label, not name prefix). */
export async function listRunnerServers(config: Config): Promise<RunnerServer[]> {
  const { status, data } = await hcloudRequest(
    config.hcloudToken,
    'GET',
    `/servers?label_selector=${encodeURIComponent(MANAGED_SELECTOR)}&per_page=50`,
  );
  if (status !== 200) throw new Error(`Hetzner server list failed: ${status}`);
  return (data.servers as any[]).map((s) => ({ id: s.id, name: s.name, created: s.created }));
}

export async function deleteServerById(config: Config, id: number, name: string): Promise<void> {
  const { status, data } = await hcloudRequest(config.hcloudToken, 'DELETE', `/servers/${id}`);
  if (status === 404) return; // already gone — fine
  if (status >= 400) throw new Error(`Hetzner server delete failed: ${status} ${data?.error?.code ?? ''}`);
  log('info', 'runner VM deleted', { name, id });
}

/** Delete by name; a server that no longer exists is not an error. */
export async function deleteServerByName(config: Config, name: string): Promise<void> {
  const { status, data } = await hcloudRequest(
    config.hcloudToken,
    'GET',
    `/servers?name=${encodeURIComponent(name)}`,
  );
  if (status !== 200) throw new Error(`Hetzner server lookup failed: ${status}`);
  const server = (data.servers as any[])[0];
  if (!server) {
    log('info', 'runner VM already gone', { name });
    return;
  }
  await deleteServerById(config, server.id, name);
}
