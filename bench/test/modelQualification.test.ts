import test from 'node:test';
import assert from 'node:assert/strict';
import { checkPlacement, qualifyModel } from '../src/modelQualification.ts';

test('hybrid placement permits CPU offload while GPU-only fails closed', () => {
  const loaded = { size: 100, size_vram: 80, context_length: 16384 };
  assert.throws(() => checkPlacement(loaded, 16384, 'gpu-only'), /placement/);
  assert.doesNotThrow(() => checkPlacement(loaded, 16384, 'hybrid'));
  assert.throws(() => checkPlacement(loaded, 32768, 'hybrid'), /context/);
  assert.throws(() => checkPlacement({ ...loaded, size_vram: 0 }, 16384, 'hybrid'));
});

test('qualification requires two complete protocol passes and never retries rejected parameters', async t => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  const answers = [{ choice: 'explicit' }, { name: 'Parcel', kind: 'interface' }, { action: 'no_change', reason: 'Already satisfied' }, { id: 2, file: 'lib/beta.ts', dependsOn: [1] }, { violates: false }, { established: false }];
  let calls = 0;
  globalThis.fetch = async (_url, init) => {
    const request = JSON.parse(String(init?.body));
    assert.equal(request.reasoning_effort, 'none');
    return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(answers[calls++ % answers.length]) } }] }));
  };
  assert.equal((await qualifyModel({ host: 'http://localhost:11435', model: 'script', params: { reasoning_effort: 'none' } })).passed, true);
  assert.equal(calls, 12);
  globalThis.fetch = async () => { calls++; return new Response('unsupported parameter', { status: 400 }); };
  calls = 0;
  const failure = await qualifyModel({ host: 'http://localhost:11435', model: 'script' });
  assert.equal(failure.passed, false);
  assert.equal(failure.compatible, false);
  assert.equal(calls, 12);
  assert.ok(failure.cases.every(row => row.error?.includes('HTTP 400')));
});
