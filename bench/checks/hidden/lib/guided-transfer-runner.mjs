/** Interpreter for independently specified transfer cases, outside candidate workspaces. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readExpected, targetDir, caseLabel } from './target.mjs';

const expected = readExpected(process.env.BENCH_EXPECTED_SLUG);
const root = targetDir(expected.family);
const pristine = new URL(`../../../fixtures/${expected.family}/`, import.meta.url);
const decode = value => value && typeof value === 'object' && '$number' in value
  ? { NaN, Infinity, '-Infinity': -Infinity }[value.$number] : value;
for (const entry of expected.cases) test(caseLabel(entry), async () => {
  if (entry.exists) { assert.ok(existsSync(join(root, entry.exists)), entry.exists); return; }
  if (entry.preserve) {
    for (const path of entry.preserve) assert.equal(readFileSync(join(root, path), 'utf8'), readFileSync(new URL(path, pristine), 'utf8'), path);
    return;
  }
  const mod = await import(pathToFileURL(join(root, entry.module ?? 'src/index.ts')).href);
  assert.equal(typeof mod[entry.call.fn], 'function');
  const invoke = () => mod[entry.call.fn](...entry.call.args.map(decode));
  if (entry.throws) { assert.throws(invoke, { name: entry.throws }); return; }
  const result = invoke();
  if (entry.type) assert.equal(typeof result, entry.type);
  else assert.deepEqual(result, entry.expect);
});
