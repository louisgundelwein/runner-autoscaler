const MAX_USER_DATA_BYTES = 32 * 1024; // Hetzner user_data limit

/**
 * cloud-init user-data for an ephemeral runner VM.
 *
 * The runner executes exactly one job (JIT config) as the unprivileged
 * `runner` user, then exits. The VM is deleted by the autoscaler on the
 * `completed` webhook or by the cleanup sweep — never by the VM itself,
 * so no Hetzner credential ever exists on the machine. Powering off would
 * not help either way: stopped Hetzner servers still incur charges.
 */
export function buildUserData(runnerVersion: string, jitConfig: string): string {
  // Both values are interpolated into YAML/shell — accept only known-safe shapes.
  if (!/^[\d.]+$/.test(runnerVersion)) throw new Error(`Unexpected runner version format: ${runnerVersion}`);
  if (!/^[A-Za-z0-9+/=]+$/.test(jitConfig)) throw new Error('Unexpected JIT config format');

  const userData = `#cloud-config
users:
  - name: runner
    shell: /bin/bash
package_update: true
packages:
  - git
  - curl
runcmd:
  - mkdir -p /home/runner/actions-runner
  - curl -fsSL https://github.com/actions/runner/releases/download/v${runnerVersion}/actions-runner-linux-x64-${runnerVersion}.tar.gz | tar xz -C /home/runner/actions-runner
  - /home/runner/actions-runner/bin/installdependencies.sh
  - chown -R runner:runner /home/runner
  - sudo -u runner bash -c 'cd /home/runner/actions-runner && ./run.sh --jitconfig ${jitConfig}'
`;
  if (Buffer.byteLength(userData) > MAX_USER_DATA_BYTES) {
    throw new Error(`user_data exceeds Hetzner's ${MAX_USER_DATA_BYTES} byte limit`);
  }
  return userData;
}
