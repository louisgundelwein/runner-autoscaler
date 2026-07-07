# runner-autoscaler

Ephemeral GitHub Actions runner autoscaler for [Hetzner Cloud](https://www.hetzner.com/cloud).
One throwaway VM per CI job — created when the job queues, deleted when it finishes.
You pay only for the minutes your jobs actually run (a cx32 costs ~€0.01/hour).

```
GitHub Actions job queued
        │  workflow_job webhook
        ▼
  runner-autoscaler ──► Hetzner API: create VM (cloud-init)
        │                     │
        │                     ▼
        │            VM registers as a just-in-time runner,
        │            runs exactly one job
        │  workflow_job "completed" webhook
        ▼
  runner-autoscaler ──► Hetzner API: delete VM
```

A cleanup sweep (every 15 min) additionally deletes any managed VM older than
`MAX_RUNNER_LIFETIME_MINUTES`, so no VM can keep billing unnoticed even if a
webhook is lost — and re-provisions runners for jobs whose webhook was missed.

## Design notes

- **JIT runners, no secrets on VMs.** The autoscaler calls GitHub's
  [`generate-jitconfig`](https://docs.github.com/en/rest/actions/self-hosted-runners#create-configuration-for-a-just-in-time-runner-for-a-repository)
  API and bakes the single-use config blob into the VM's cloud-init. No GitHub
  token and no Hetzner token ever exist on a runner VM, so CI job code cannot
  steal credentials. JIT runners are inherently ephemeral: one job, then GitHub
  removes them.
- **Idempotent by construction.** VM names are `ci-runner-<job_id>`; Hetzner
  enforces unique names per project, so duplicate webhook deliveries cannot
  create duplicate VMs. Deleting an already-deleted VM is a no-op.
- **Zero runtime dependencies.** Plain Node 22 (`node:http`, `node:crypto`,
  `fetch`). The production image contains only the compiled `dist/`.
- **Multi-repo.** One deployment serves any number of repositories via the
  `GITHUB_REPOS` allowlist.

## Setup

### 1. GitHub token

Create a [fine-grained personal access token](https://github.com/settings/personal-access-tokens/new):

- **Repository access**: select the repositories that should get runners
- **Repository permissions**:
  - **Administration: Read and write** (JIT runner registration)
  - **Actions: Read** (reconcile pass for queued jobs)

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

The container exposes port 8080 (`POST /webhook`, `GET /health`).

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

First run: expect ~60–90 s of queue time while the VM boots and the runner
installs, then the job starts.

### Adding another repository later

1. Add the repo to the PAT's repository access.
2. Create the webhook on the repo (step 4).
3. Add `owner/repo` to `GITHUB_REPOS` and restart the service.

## Configuration

All configuration is via environment variables — see [.env.example](.env.example).

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `GITHUB_WEBHOOK_SECRET` | ✔ | — | Webhook HMAC secret (shared with every repo webhook) |
| `GITHUB_TOKEN` | ✔ | — | Fine-grained PAT (Administration RW + Actions R) |
| `GITHUB_REPOS` | ✔ | — | Comma-separated `owner/repo` allowlist |
| `HCLOUD_TOKEN` | ✔ | — | Hetzner Cloud API token |
| `HETZNER_SERVER_TYPE` | | `cx33` | VM type for runners |
| `HETZNER_IMAGE` | | `ubuntu-24.04` | VM image |
| `HETZNER_LOCATION` | | `nbg1` | Hetzner location |
| `HETZNER_SSH_KEY` | | — | Optional SSH key (name or ID) for debugging VMs |
| `RUNNER_LABELS` | | `self-hosted,hetzner` | Labels runners register with |
| `MAX_RUNNERS` | | `3` | Max concurrent runner VMs |
| `MAX_RUNNER_LIFETIME_MINUTES` | | `120` | Hard VM age cap — must exceed your longest job |
| `CLEANUP_INTERVAL_MINUTES` | | `15` | Cleanup/reconcile sweep interval |
| `PORT` | | `8080` | HTTP port |

## Security

- **Only use this for private repositories.** On public repos, anyone can open
  a fork PR and run arbitrary code on your VMs. See GitHub's
  [self-hosted runner security notes](https://docs.github.com/en/actions/security-guides/security-hardening-for-github-actions#hardening-for-self-hosted-runners).
- Webhook requests are verified with HMAC-SHA256 (`X-Hub-Signature-256`,
  constant-time comparison); invalid signatures get 401.
- Runner VMs contain no credentials (see design notes) and accept no inbound
  traffic requirement — the runner only makes outbound HTTPS long-polls. Add
  `HETZNER_SSH_KEY` only when you need to debug.
- Secrets never appear in logs.

## Development

```bash
npm install
npm test          # node:test — signature, label matching, cloud-init, lifetimes
npm run build     # tsc → dist/
npm run dev       # run locally with .env
```

## Troubleshooting

- **Job stays queued, no VM appears** — check webhook deliveries (repo →
  Settings → Webhooks → Recent Deliveries): 401 means wrong secret, timeout
  means the service is down. The reconcile sweep provisions missed jobs within
  `CLEANUP_INTERVAL_MINUTES` on its own.
- **Job stays queued, VM exists** — boot/install takes ~60–90 s. If it never
  starts, create the VM with `HETZNER_SSH_KEY` set and inspect
  `/var/log/cloud-init-output.log` on the VM.
- **VM survives a job** — the cleanup sweep removes it after
  `MAX_RUNNER_LIFETIME_MINUTES` at the latest. Check the service logs for
  failed delete calls.
- **`runner cap reached` in logs** — raise `MAX_RUNNERS` or let the reconcile
  pass pick the job up once a slot frees.

## License

[MIT](LICENSE)
