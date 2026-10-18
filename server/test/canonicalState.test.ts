import { strict as assert } from 'node:assert';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { WitokPaths, isRuntimeServicePath } from '../src/artifacts/paths.ts';
import { initializeCanonicalState, readCanonicalState, recordCanonicalDecision, synchronizeStateClaims, validateCanonicalState } from '../src/run/canonicalState.ts';
import { readRunVerdict, writeRunVerdict } from '../src/run/verdictStore.ts';
import { acceptanceFresh, acceptanceProblem, registerAcceptance, runIndependentAcceptance } from '../src/run/independentAcceptance.ts';
import { commitTargets } from '../src/run/commitByRuntime.ts';
import { atomicJson, protectedRunDir, sha256 } from '../src/run/protectedStore.ts';
import { loadConfig } from '../src/config/load.ts';
import { isolatedNode, pinNodeImage } from '../src/run/isolatedNode.ts';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'canonical-contract-'));
  const suite = mkdtempSync(join(tmpdir(), 'independent-contract-'));
  const paths = new WitokPaths(root, 'change');
  mkdirSync(paths.dir, { recursive: true });
  writeFileSync(join(root, 'module.mjs'), 'export const add = (a,b) => a-b;\n');
  writeFileSync(paths.plan, '# Approved plan\n');
  execFileSync('git', ['init', '-q'], { cwd: root });
  initializeCanonicalState(paths);
  synchronizeStateClaims(paths, '| id | Пункт | Как проверить |\n|---|---|---|\n| claim-1 | Sum of two numbers | independent examples |\n', 'plan');
  recordCanonicalDecision(paths, { kind: 'plan:approval', by: 'Operator', at: new Date().toISOString(), value: 'granted' });
  writeFileSync(join(suite, 'behavior.test.mjs'), "import test from 'node:test';import assert from 'node:assert/strict';const {add}=await import(process.env.SDLC_CANDIDATE_ROOT+'/module.mjs');test('signed sum',()=>{assert.equal(add(3,5),8);assert.equal(add(-3,5),2)});\n");
  return { root, suite, paths, cleanup: () => { rmSync(root, { recursive: true, force: true }); rmSync(suite, { recursive: true, force: true }); } };
}

test('state-first persists exact claims/decisions and never trusts a forged legacy or canonical verdict', () => {
  const f = fixture();
  try {
    assert.equal(readCanonicalState(f.paths)?.state.claims[0]?.text, 'Sum of two numbers');
    assert.equal(readCanonicalState(f.paths)?.state.decisions.length, 1);
    writeRunVerdict(f.paths, 1, 1, { passed: true, action: 'continue', reasons: [] });
    assert.equal(readRunVerdict(f.paths, 1, 1), null);
    const file = join(f.paths.dir, 'state.json');
    writeFileSync(file, '{');
    assert.throws(() => readCanonicalState(f.paths));
    assert.equal(readRunVerdict(f.paths, 1, 1), null);
  } finally { f.cleanup(); }
});

test('state-first rejects unknown fields and contradictory success; protected artifacts remain committable', () => {
  const f = fixture();
  try {
    const state = readCanonicalState(f.paths)!.state;
    assert.throws(() => validateCanonicalState({ ...state, unknown: true }));
    state.verification.passed = true;
    assert.throws(() => validateCanonicalState(state));
    for (const name of ['state.json', 'acceptance-checks.md']) assert.equal(isRuntimeServicePath(name), true);
    assert.deepEqual(commitTargets(['.sdlc/change/state.json', '.sdlc/change/acceptance-checks.md', '.sdlc/change/.runner/x.json'], [], '.sdlc/change/', f.root), ['.sdlc/change/state.json', '.sdlc/change/acceptance-checks.md']);
  } finally { f.cleanup(); }
});

const image = process.env['SDLC_TEST_DOCKER_IMAGE'];
test('interrupted state transaction recovers only recorded bytes; conflicting changes remain blocked', () => {
  const f = fixture();
  try {
    const current = readCanonicalState(f.paths)!;
    const next = structuredClone(current.state); next.stage = 'ask';
    const pending = join(protectedRunDir(f.root, f.paths.slug), 'state-pending.json');
    const receipt = { ...current.receipt, hash: sha256(JSON.stringify(next, null, 2) + '\n') };
    atomicJson(pending, { previousHash: current.receipt.hash, state: next, receipt });
    assert.equal(readCanonicalState(f.paths)?.state.stage, 'ask');
    const newState = readCanonicalState(f.paths)!;
    atomicJson(pending, { previousHash: newState.receipt.hash, state: current.state, receipt: current.receipt });
    writeFileSync(join(f.paths.dir, 'state.json'), '{}');
    assert.throws(() => readCanonicalState(f.paths), /конфликтует/);
    assert.equal(readFileSync(join(f.paths.dir, 'state.json'), 'utf8'), '{}', 'recovery never overwrites unknown external bytes');
  } finally { f.cleanup(); }
});

let methodology = process.env['SDLC_METHODOLOGY_DIR'];
try { methodology ||= loadConfig().runner.methodologyDir; } catch { /* Explicit skip below if the external reference is unavailable. */ }
test('canonical state conforms to the independent methodology validator', { skip: !methodology }, () => {
  const f = fixture();
  try {
    const tool = join(methodology!, 'implementations/runner-contract/tools/state_contract.py');
    const python = ['python', 'python3'].find(command => spawnSync(command, ['--version'], { windowsHide: true }).status === 0);
    assert.ok(python, 'Python is required to verify the external contract');
    const run = spawnSync(python!, [tool, 'validate-state', join(f.paths.dir, 'state.json')], { encoding: 'utf8', windowsHide: true });
    assert.equal(run.status, 0, run.stdout + run.stderr);
  } finally { f.cleanup(); }
});

test('independent acceptance runs a red baseline, accepts a repair, rejects stale evidence and protects its suite', { skip: !image }, async () => {
  const f = fixture();
  try {
    const input = { sourceDir: f.suite, image, author: { kind: 'human', id: 'Independent reviewer' }, qualification: 'Prepared from the approved requirement', checks: [{ claimId: 'claim-1', file: 'behavior.test.mjs', name: 'signed sum' }], limitations: 'Node modules with built-in dependencies' };
    assert.notEqual(acceptanceProblem(f.paths), null);
    await assert.rejects(registerAcceptance(f.paths, { ...input, author: { kind: 'model', id: 'local:worker' } }, 'Operator', 'local:worker'));
    const registered = await registerAcceptance(f.paths, input, 'Operator', 'local:worker');
    assert.equal(registered.baselinePassed, false);
    writeFileSync(join(f.root, 'module.mjs'), 'export const add = (a,b) => a+b;\n');
    assert.equal((await runIndependentAcceptance(f.paths, 1, 1)).status, '✅');
    assert.equal(acceptanceFresh(f.paths, 1, 1), true);
    writeFileSync(join(f.root, 'module.mjs'), 'export const add = () => 0;\n');
    assert.equal(acceptanceFresh(f.paths, 1, 1), false);
    assert.equal((await runIndependentAcceptance(f.paths, 1, 2)).status, '❌');
    writeFileSync(join(f.root, 'module.mjs'), 'process.exit(0);export const add=(a,b)=>a+b;\n');
    assert.equal((await runIndependentAcceptance(f.paths, 1, 4)).status, '❌', 'process exit without the named checks never proves acceptance');
    writeFileSync(join(f.root, 'module.mjs'), "import fs from 'node:fs';fs.writeFileSync('/checks/behavior.test.mjs','');export const add=(a,b)=>a+b;\n");
    assert.equal((await runIndependentAcceptance(f.paths, 1, 3)).status, '❌');
    assert.equal(acceptanceProblem(f.paths), null, 'candidate cannot rewrite a read-only suite');
    assert.ok(readFileSync(join(f.paths.dir, 'state-evidence', 'acceptance-1-3.txt'), 'utf8').includes('EROFS'));
  } finally { f.cleanup(); }
});

test('isolated Docker command is stopped and removed on deadline', { skip: !image }, async () => {
  const run = await isolatedNode({ image: pinNodeImage(image!), files: [{ path: 'wait.mjs', bytes: Buffer.from("console.log('running');setInterval(()=>{},1000);\n") }], argv: ['wait.mjs'], timeoutMs: 5000 });
  assert.equal(run.timedOut, true);
  assert.match(run.stdout, /running/);
  assert.notEqual(spawnSync('docker', ['inspect', run.container], { windowsHide: true }).status, 0, 'the container is removed before the call returns');
});
