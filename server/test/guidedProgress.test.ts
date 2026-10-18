import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { WitokPaths } from '../src/artifacts/paths.ts';
import { GuidedProgress, progressHash } from '../src/run/guidedProgress.ts';

test('progress survives restart and invalidates only changed inputs and their dependants', t => {
  const root = mkdtempSync(join(tmpdir(), 'guided-progress-'));
  t.after(() => { assert.ok(!relative(tmpdir(), root).startsWith('..')); rmSync(root, { recursive: true, force: true }); });
  const paths = new WitokPaths(root, 'task');
  const store = new GuidedProgress(paths);
  const deps = { source: 'v1' };
  store.accept(store.begin('research:a', 'explore', deps), { fact: 'a' }, deps);
  store.accept(store.begin('research:b', 'explore', deps), { fact: 'b' }, deps);
  const dependent = { 'unit:research:a': progressHash({ fact: 'a' }) };
  store.accept(store.begin('plan:a', 'plan', dependent), { action: 'change a' }, dependent);
  const restarted = new GuidedProgress(paths);
  assert.deepEqual(restarted.reuse(restarted.begin('research:a', 'explore', deps), v => v), { fact: 'a' });
  restarted.begin('research:a', 'explore', { source: 'v2' });
  assert.equal(restarted.read().units['research:a']!.status, 'stale');
  assert.equal(restarted.read().units['plan:a']!.status, 'stale');
  assert.equal(restarted.read().units['research:b']!.status, 'proposed');
  assert.equal(restarted.summary().observed, 0);
  const staleParentTicket = restarted.begin('plan:c', 'plan', dependent);
  assert.throws(() => restarted.accept(staleParentTicket, { action: 'use stale a' }, dependent), /устарело/);
});

test('a model response cannot overwrite a newer proposal or changed source', t => {
  const root = mkdtempSync(join(tmpdir(), 'guided-progress-'));
  t.after(() => { assert.ok(!relative(tmpdir(), root).startsWith('..')); rmSync(root, { recursive: true, force: true }); });
  const store = new GuidedProgress(new WitokPaths(root, 'task'));
  const ticket = store.begin('claim-1', 'intent', { request: 'a' });
  assert.throws(() => store.accept(ticket, 'old', { request: 'b' }), /устарело/);
  store.accept(ticket, 'first', ticket.dependencies);
  assert.throws(() => store.accept(ticket, 'second', ticket.dependencies), /Конфликт/);
  assert.equal(store.read().units['claim-1']!.value, 'first');
});

test('two corrections, one narrowed attempt, then a durable stop; wording does not reset recovery', t => {
  const root = mkdtempSync(join(tmpdir(), 'guided-progress-'));
  t.after(() => { assert.ok(!relative(tmpdir(), root).startsWith('..')); rmSync(root, { recursive: true, force: true }); });
  const paths = new WitokPaths(root, 'task');
  const store = new GuidedProgress(paths);
  const ticket = store.begin('research:a', 'explore', { source: 'v1' });
  assert.equal(store.reject(ticket, 'format', 'bad JSON'), 'retry');
  assert.equal(store.reject(ticket, 'schema', 'wrong fields'), 'retry');
  assert.equal(new GuidedProgress(paths).reject(ticket, 'schema', 'another explanation'), 'narrow');
  assert.equal(store.reject(ticket, 'schema', 'still wrong'), 'stop');
  assert.equal(store.summary().recoveries['research:a']!.stopped, true);
  assert.equal(store.reject(store.begin('research:a', 'explore', { source: 'v2' }), 'schema', 'changed input'), 'retry');
});
