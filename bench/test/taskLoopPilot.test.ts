import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registeredNodeArgs, pilotCases } from '../src/taskLoopPilot.ts';
import { resolve } from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
test('trusted Node check argv preserves quoted globs and rejects shell syntax', () => {
  assert.deepEqual(registeredNodeArgs('node --test "spec/**/*.test.ts"'), ['--test', 'spec/**/*.test.ts']);
  for (const command of ['node check.js && echo yes', 'node $(whoami)', 'npm test', 'node "unterminated', 'node check.js; x'])
    assert.throws(() => registeredNodeArgs(command));
});
test('an experiment outside fingerprinted configuration is rejected', () => {
  assert.throws(() => pilotCases(resolve(import.meta.dirname, '../..'), '../external.json'), /fingerprinted/);
});
test('explicit experiment files cannot escape their fingerprinted roots', () => {
  const root = mkdtempSync(resolve(tmpdir(), 'pilot-config-'));
  mkdirSync(resolve(root, 'bench/experiments'), {recursive:true});
  const base = {task:'neutral',writable:['lib/'],preserveExisting:[],exceptions:[],requireNewTest:false,requireReadmeChange:false,requiredQuestionTags:[]};
  for (const extra of [{visibleChecks:[{name:'check',file:'outside.mjs'}]}, {fixture:{directory:'bench/fixtures/neutral',taskFile:'../task.md',humanFile:'bench/fixtures/neutral/human.json',hiddenFile:'bench/checks/neutral.mjs'}}]) {
    writeFileSync(resolve(root,'bench/experiments/test.json'),JSON.stringify({cases:[{...base,...extra}]}));
    assert.throws(()=>pilotCases(root,'bench/experiments/test.json'),/fingerprinted/);
  }
});
