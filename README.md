# runner-autoscaler

Ephemeral GitHub Actions runner autoscaler for [Hetzner Cloud](https://www.hetzner.com/cloud).
With **v2 VM reuse**, a single VM runs multiple jobs within its billed hour, reducing costs.
Billed hour boundaries are respected — VMs drain at minute 50 and shut down before the next hour starts.
A cx33 costs ~€0.01/hour, so reusing one VM for N jobs saves N–1 hours of billing.

```
GitHub Actions job queued
        │  workflow_job webhook
        ▼
  runner-autoscaler ──► Hetzner API: create VM (cloud-init + agent loop)
        │                     │
        │                     ▼
        │            VM runs agent loop:
        │              1. ./run.sh --jitconfig <job 1>
        │              2. POST /next-runner → poll for next job
        │              3. Repeat until drain window (min 50) or no jobs
        │                     │
        │ (no webhook needed)  ▼
        │            VM POSTs /next-runner every time a job finishes
        │              ├─ 200 + fresh jitconfig → run job 2, 3, ...
        │              └─ 204 (drain) → exit gracefully
        │                     │
        ▼ (2-min tick)        ▼
  runner-autoscaler: pool tick (drain check, self-heal, reconcile)
        │ • Delete VMs past max lifetime (hard cap)
        │ • Drain VMs in minute 50+ with no active runners
        │ • Self-heal: replace VMs never-online after 12+ min
        │ • Reconcile: provision runners for still-queued jobs
        ▼
  Hetzner API: delete VM (if draining or past max lifetime)
```

Security: VM agent uses a per-VM token (HMAC of vmName + webhook secret) to authenticate
/next-runner requests — the webhook secret itself never leaves the autoscaler.

## Design notes

- **VM reuse within billed hours.** VMs run multiple jobs (via `agent-loop.sh`) within
  their billed hour and drain gracefully at minute 50. No per-job webhooks needed — the
  agent loop polls `/next-runner` for the next jitconfig. This reduces billing by ~50%
  for most CI pipelines (5 sequential jobs → 1 VM instead of 5).

- **JIT runners, no secrets on VMs.** The autoscaler calls GitHub's
  [`generate-jitconfig`](https://docs.github.com/en/rest/actions/self-hosted-runners#create-configuration-for-a-just-in-time-runner-for-a-repository)
  API once per job and bakes each config into the `/next-runner` response. No GitHub
  token and no Hetzner token ever exist on a runner VM. The webhook secret is never
  sent to the VM — only a per-VM token (HMAC-SHA256 of vmName) for `/next-runner` auth.

- **Idempotent by construction.** VM names are `ci-runner-<job_id>`; Hetzner enforces
  unique names per project. Runner names within a VM are `<vmName>-r<N>` (monotonic).
  Duplicate webhook deliveries cannot create duplicate VMs, and reconcile is safe.

- **Drain window and cost discipline.** VMs enter a drain window at minute 50 of each
  billed hour and signal jobs to exit via 204 status on `/next-runner`. The pool tick
  (every 2 min by default) detects drain readiness and deletes VMs with no active
  runners. This ensures billing never exceeds max lifetime and respects hour boundaries.

- **Self-healing.** If a VM is alive 12+ minutes with no online/busy runners, it likely
  never came online (dead networking). The pool tick detects and replaces it automatically,
  and reconcile provisions a fresh VM for still-queued jobs.

- **Zero runtime dependencies.** Plain Node 22 (`node:http`, `node:crypto`, `fetch`).
  The production image contains only the compiled `dist/`.

- **Multi-repo.** One deployment serves any number of repositories via the
  `GITHUB_REPOS` allowlist.

## Setup

### 1. GitHub token

Create a [fine-grained personal access token](https://github.com/settings/personal-access-tokens/new):

- **Repository access**: select the repositories that should get runners
- **Repository permissions**:
  - **Administration: Read and write** (JIT runner registration)
  - **Actions: Read** (reconcile pass for queued jobs)
  - **Commit statuses: Read and write** (error status on the PR when provisioning fails)
  - **Issues: Read and write** (escalation issue after repeated provisioning failures)

The last two are optional — without them failures are only visible in the
service logs (the autoscaler logs the 403 and carries on).

### 2. Hetzner Cloud token

In the [Hetzner Cloud Console](https://console.hetzner.cloud/), open your
project → Security → API tokens → generate a **Read & Write** token.

### 3. Deploy the service

The webhook endpoint must be reachable via HTTPS (GitHub requires TLS), so run
it behind your reverse proxy (Traefik, Caddy, nginx, or a PaaS like Dokploy
that terminates TLS for compose services).

```bash
cp .env.example .env   # fill in the four required values
docker compose up -d --build
```

The container exposes port 8080 (`POST /webhook`, `POST /next-runner`, `GET /health`).

### 4. Repository webhook (per repo)

```bash
gh api repos/OWNER/REPO/hooks -f name=web -F active=true \
  -f 'events[]=workflow_job' \
  -f config[url]='https://your-domain.example/webhook' \
  -f config[content_type]=json \
  -f config[secret]="$GITHUB_WEBHOOK_SECRET"
```

(Or repo → Settings → Webhooks: payload URL, content type `application/json`,
your secret, and only the **Workflow jobs** event.)

### 5. Use it in a workflow

```yaml
jobs:
  build:
    runs-on: [self-hosted, hetzner]
    steps:
      - uses: actions/checkout@v4
      - run: echo "running on an ephemeral Hetzner VM"
```

First run: expect ~2–5 min of queue time while the VM boots and the runner
installs (apt update + .NET dependencies take most of it), then the job starts.

### Adding another repository later

1. Add the repo to the PAT's repository access.
2. Create the webhook on the repo (step 4).
3. Add `owner/repo` to `GITHUB_REPOS` and restart the service.

## Configuration

All configuration is via environment variables — see [.env.example](.env.example).

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `GITHUB_WEBHOOK_SECRET` | ✔ | — | Webhook HMAC secret (shared with every repo webhook and for VM tokens) |
| `GITHUB_TOKEN` | ✔ | — | Fine-grained PAT (Administration RW + Actions R) |
| `GITHUB_REPOS` | ✔ | — | Comma-separated `owner/repo` allowlist |
| `HCLOUD_TOKEN` | ✔ | — | Hetzner Cloud API token |
| `PUBLIC_URL` | ✔ | — | Public HTTPS URL of this autoscaler (for VMs to reach `/next-runner`) |
| `HETZNER_SERVER_TYPE` | | `cx33` | VM type for runners |
| `HETZNER_IMAGE` | | `ubuntu-24.04` | VM image |
| `HETZNER_LOCATION` | | `nbg1` | Hetzner location |
| `HETZNER_SSH_KEY` | | — | Optional SSH key (name or ID) for debugging VMs |
| `RUNNER_LABELS` | | `self-hosted,hetzner` | Labels runners register with |
| `MAX_RUNNERS` | | `3` | Max concurrent runner VMs |
| `MAX_RUNNER_LIFETIME_MINUTES` | | `360` | Hard VM age cap (6 hours default for reuse model; must exceed longest job) |
| `CLEANUP_INTERVAL_MINUTES` | | `2` | Pool tick interval — detects drain window, self-heals, reconciles (recommended 2 min) |
| `PORT` | | `8080` | HTTP port |

## Security

- **Only use this for private repositories.** On public repos, anyone can open
  a fork PR and run arbitrary code on your VMs. See GitHub's
  [self-hosted runner security notes](https://docs.github.com/en/actions/security-guides/security-hardening-for-github-actions#hardening-for-self-hosted-runners).

- **Webhook signature verification** (`X-Hub-Signature-256`, timing-safe HMAC-SHA256);
  invalid signatures get 401.

- **VM token authentication** on `/next-runner`: each VM receives a per-VM token
  (HMAC-SHA256 of vmName keyed with the webhook secret). The VM sends it with each
  `/next-runner` POST and the autoscaler verifies it with timing-safe comparison.
  **Residual risk:** Job code running on the VM can read its token from the baked
  user-data and pull additional jitconfigs for that same VM — but both are in the
  same trust domain (private repos), so this is acceptable. The webhook secret itself
  never reaches the VM.

- Runner VMs contain no credentials and accept no inbound traffic — the runner makes
  only outbound HTTPS long-polls to GitHub and `/next-runner` POSTs to the autoscaler.
  Add `HETZNER_SSH_KEY` only when you need to debug.

- Secrets never appear in logs — neither webhook secrets nor tokens.

## Development

```bash
npm install
npm test          # node:test — signature, label matching, cloud-init, lifetimes
npm run build     # tsc → dist/
npm run dev       # run locally with .env
```

## Troubleshooting

- **Job stays queued, no VM appears** — provisioning failures show up as a red
  `runner-autoscaler` commit status on the PR (and after 3 consecutive
  failures as an auto-opened issue labeled `runner-autoscaler`). Also check
  webhook deliveries (repo → Settings → Webhooks → Recent Deliveries): 401
  means wrong secret, timeout means the service is down. The reconcile sweep
  provisions missed jobs within `CLEANUP_INTERVAL_MINUTES` on its own.
- **Job stays queued, VM exists** — boot/install takes ~2–5 min. If it never
  starts, create the VM with `HETZNER_SSH_KEY` set and inspect
  `/var/log/cloud-init-output.log` on the VM.
- **VM survives a job** — the cleanup sweep removes it after
  `MAX_RUNNER_LIFETIME_MINUTES` at the latest. Check the service logs for
  failed delete calls.
- **`runner cap reached` in logs** — raise `MAX_RUNNERS` or let the reconcile
  pass pick the job up once a slot frees.

## License

[MIT](LICENSE)
