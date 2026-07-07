const MAX_USER_DATA_BYTES = 32 * 1024; // Hetzner user_data limit

/**
 * cloud-init user-data for a reusable runner VM.
 *
 * The runner executes jobs (JIT configs) as the unprivileged `runner` user via
 * an agent loop. After each job, it POSTs to /next-runner to poll for the next
 * jitconfig. The VM is deleted by the autoscaler's cleanup sweep when it enters
 * the drain window (minute 50+ of each billed hour) or exceeds max lifetime.
 * No Hetzner credential ever exists on the machine, and the webhook secret is
 * never transmitted to the VM — only a per-VM token computed from it.
 */
export function buildUserData(
  runnerVersion: string,
  initialJitConfig: string,
  vmName: string,
  token: string,
  publicUrl: string,
): string {
  // All values are interpolated into YAML/shell — accept only known-safe shapes.
  if (!/^[\d.]+$/.test(runnerVersion)) throw new Error(`Unexpected runner version format: ${runnerVersion}`);
  if (!/^[A-Za-z0-9+/=]+$/.test(initialJitConfig)) throw new Error('Unexpected JIT config format');
  if (!/^[a-z0-9.-]+$/.test(vmName)) throw new Error(`Unexpected VM name format: ${vmName}`);
  if (!/^[a-f0-9]{64}$/.test(token)) throw new Error('Unexpected token format (expect 64-char hex)');
  if (!/^https?:\/\//.test(publicUrl)) throw new Error('Unexpected public URL format');

  const agentLoop = `#!/bin/bash
set +e

INITIAL_JIT='${initialJitConfig}'
VM_NAME='${vmName}'
TOKEN='${token}'
PUBLIC_URL='${publicUrl}'
MAX_RETRIES=3

jitconfig="$INITIAL_JIT"

while true; do
  echo "[agent-loop] running job with jitconfig..." >&2
  cd /home/runner/actions-runner
  ./run.sh --jitconfig "$jitconfig"
  exit_code=$?

  echo "[agent-loop] job exited with code $exit_code, polling for next..." >&2

  retries=0
  while [ $retries -lt $MAX_RETRIES ]; do
    response_file="/tmp/next-runner-resp"
    http_code=$(curl -s -o "$response_file" -w '%{http_code}' \\
      -X POST \\
      -H 'Content-Type: application/json' \\
      -d "{\"vmName\":\"$VM_NAME\",\"token\":\"$TOKEN\"}" \\
      "$PUBLIC_URL/next-runner")

    if [ "$http_code" = "200" ]; then
      jitconfig=$(grep -o '"jitconfig":"[^"]*"' "$response_file" | cut -d'"' -f4)
      if [ -n "$jitconfig" ]; then
        echo "[agent-loop] got next jitconfig, continuing..." >&2
        break
      else
        echo "[agent-loop] failed to parse jitconfig from response" >&2
        retries=$((retries + 1))
        sleep 10
        continue
      fi
    elif [ "$http_code" = "204" ]; then
      echo "[agent-loop] received drain signal (204), shutting down" >&2
      exit 0
    else
      echo "[agent-loop] next-runner returned $http_code, retrying..." >&2
      retries=$((retries + 1))
      sleep 10
    fi
  done

  if [ $retries -ge $MAX_RETRIES ]; then
    echo "[agent-loop] max retries exceeded, exiting" >&2
    exit 1
  fi
done
`;

  const userData = `#cloud-config
users:
  - name: runner
    shell: /bin/bash
package_update: true
packages:
  - git
  - curl
write_files:
  - path: /home/runner/agent-loop.sh
    permissions: '0755'
    owner: runner:runner
    content: |
${agentLoop.split('\n').map((line) => '      ' + line).join('\n')}
runcmd:
  - fallocate -l 8G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
  - mkdir -p /home/runner/actions-runner
  - curl -fsSL https://github.com/actions/runner/releases/download/v${runnerVersion}/actions-runner-linux-x64-${runnerVersion}.tar.gz | tar xz -C /home/runner/actions-runner
  - /home/runner/actions-runner/bin/installdependencies.sh
  - chown -R runner:runner /home/runner
  - sudo -u runner /home/runner/agent-loop.sh
`;
  if (Buffer.byteLength(userData) > MAX_USER_DATA_BYTES) {
    throw new Error(`user_data exceeds Hetzner's ${MAX_USER_DATA_BYTES} byte limit`);
  }
  return userData;
}
