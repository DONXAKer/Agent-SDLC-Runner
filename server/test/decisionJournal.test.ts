import { test } from 'node:test';
import { equal } from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { emptyUsage } from '@sdlc-runner/shared';
import { WitokPaths } from '../src/artifacts/paths.ts';
import { observeDecisions } from '../src/run/decisionJournal.ts';
import { atomicJson } from '../src/fs/atomicJson.ts';

test('runtime observations classify deadlines and environment failures without guessing from message text', t => {
  const root = mkdtempSync(join(tmpdir(), 'decision-observation-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const paths = new WitokPaths(root, 'task');
  const failed = { ok: false, finalText: '', usage: emptyUsage(), note: 'arbitrary message' };
  equal(observeDecisions(paths, 'plan', Date.now(), { ...failed, stopCause: 'stage-deadline' }).diagnostic?.category, 'budget');
  equal(observeDecisions(paths, 'intent', Date.now(), { ...failed, envFailure: 'transport failed' }).diagnostic?.category, 'environment');
  equal(observeDecisions(paths, 'ask', Date.now(), failed).diagnostic?.category, 'unassessed');
  equal(observeDecisions(paths, 'ask', Date.now(), { ...failed, diagnostic: { category: 'human-required' } }).diagnostic?.category, 'human-required');
});

test('decision journal replaces optimistic executor request counts with observed provider calls', t => {
  const root = mkdtempSync(join(tmpdir(), 'decision-observation-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const paths = new WitokPaths(root, 'task');
  const at = Date.now();
  atomicJson(join(paths.dir, '.runner', 'decisions', 'ask', '11111111-1111-1111-1111-111111111111.json'), {
    decisionId: '11111111-1111-1111-1111-111111111111', status: 'proposed', at: new Date(at).toISOString(), entries: [
      { attempt: 1, providerAccepted: true, answer: '{"decision":"keep"}' },
      { attempt: 2, providerAccepted: true, answer: '{"decision":"keep"}' },
      { attempt: 3 },
    ],
  });
  const result = observeDecisions(paths, 'ask', at - 1000, { ok: true, finalText: '', usage: emptyUsage(), note: 'done', modelRequests: 1 });
  equal(result.modelRequests, 2);
  equal(result.decisionStats?.requests, 2);
  equal(result.decisionStats?.repairs, 1);
  atomicJson(join(paths.dir, '.runner', 'decisions', 'ask', '22222222-2222-2222-2222-222222222222.json'), {
    decisionId: '22222222-2222-2222-2222-222222222222', status: 'replayed', at: new Date(at + 1).toISOString(), entries: [],
  });
  atomicJson(join(paths.dir, '.runner', 'decisions', 'ask', '33333333-3333-3333-3333-333333333333.json'), {
    decisionId: '33333333-3333-3333-3333-333333333333', status: 'invalid-response', at: new Date(at + 2).toISOString(), entries: [], extra: { proposalHash: 'same' },
  });
  const observed = observeDecisions(paths, 'ask', at - 1000, { ok: false, finalText: '', usage: emptyUsage(), note: 'failed', modelRequests: 99 });
  equal(observed.modelRequests, 2);
  equal(observed.decisionStats?.replays, 1);
  equal(observed.decisionStats?.repeatedRejections, 1);
  equal(observed.decisionStats?.failures['invalid-response'], 1);
});
