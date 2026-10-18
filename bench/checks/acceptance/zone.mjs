import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
const target = await import(pathToFileURL(join(resolve(process.env.BENCH_TARGET_DIR), 'src/index.ts')).href);
const baseline = await import(new URL('../../fixtures/cli-tool/src/index.ts', import.meta.url));
test('G1 [contract]: filtering preserves format for every registered zone', () => {
  for (const zone of baseline.ZONES)
    assert.equal(target.run(['list', '--zone', zone]), baseline.formatTable([[zone, baseline.RATE_PER_KG[zone] / 100]]));
});
test('G2 [contract]: unfiltered output and unrelated quote command are unchanged', () => {
  for (const args of [['list'], ['quote', 'ural', '2'], ['quote', 'msk', '3']])
    assert.equal(target.run(args), baseline.run(args));
});
test('G3 [contract]: unknown zone is an empty filter result', () => {
  assert.equal(target.run(['list', '--zone', 'unregistered-zone']), 'ничего не найдено');
});
