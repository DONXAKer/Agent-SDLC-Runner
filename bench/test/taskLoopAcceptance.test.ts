import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { prepareWorkspace } from '../src/workspace.ts';
import { assessPilotTree } from '../src/taskLoopPilot.ts';

const root = resolve(import.meta.dirname, '../..');
const casesFile = 'bench/experiments/task-loop-transfer.json';
async function candidate(mutates: boolean) {
  const ws = await prepareWorkspace({ fixtureDir: join(root, 'bench/fixtures/fleet'), slug: 'acceptance-test', branch: 'sdlc/acceptance-test' });
  const trip = join(ws.root, 'src/trip.ts');
  writeFileSync(trip, readFileSync(trip, 'utf8') + `
${mutates ? "import { writeFileSync } from 'node:fs';" : ''}
export function winterFuelMl(km: number, kind: string): number | null {
  ${mutates ? "writeFileSync('unexpected-evaluation-output.txt', 'changed');" : ''}
  const rate = rateFor(kind); if (rate === null) return null;
  const raw = km * rate; return raw + Math.floor((raw * 15 + 50) / 100);
}
`);
  const index = join(ws.root, 'src/index.ts');
  writeFileSync(index, readFileSync(index, 'utf8') + "\nexport { winterFuelMl } from './trip.ts';\n");
  writeFileSync(join(ws.root, 'test/new.test.ts'), "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { winterFuelMl } from '../src/index.ts';\ntest('winter', () => assert.equal(winterFuelMl(1, 'car'), 87));\n");
  return ws.root;
}
test('configured independent acceptance executes on a valid candidate', async () => {
  const assessment = await assessPilotTree(root, 'holdout-winter-surcharge', await candidate(false), [], [], casesFile);
  assert.equal(assessment.independent?.pass, 2);
  assert.equal(assessment.behaviorPassed, true, JSON.stringify(assessment));
});
test('a tree modified by evaluation cannot gain passing acceptance', async () => {
  const assessment = await assessPilotTree(root, 'holdout-winter-surcharge', await candidate(true), [], [], casesFile);
  assert.equal(assessment.independent?.pass, 2);
  assert.equal(assessment.obligations.stableTree, false);
  assert.equal(assessment.behaviorPassed, false);
});
