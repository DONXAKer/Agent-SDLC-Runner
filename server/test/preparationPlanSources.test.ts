import { ok, strictEqual } from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { WitokPaths } from '../src/artifacts/paths.ts';
import { initializePreparation, preparation, recordPreparationRead, savePreparation } from '../src/artifacts/preparation.ts';
import { preparationReviewFacts, preparationSourceFacts } from '../src/run/stages/plan.ts';

const roots: string[] = [];
after(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });

function setup(): { paths: WitokPaths; sourcePath: string; source: string } {
  const root = mkdtempSync(join(tmpdir(), 'sdlc-plan-sources-'));
  roots.push(root);
  mkdirSync(join(root, 'src'), { recursive: true });
  const paths = new WitokPaths(root, 'demo');
  const sourcePath = join(root, 'src', 'hold.ts');
  const source = 'export function makeHold() { return { slot: { startIso: "x" } }; }\n';
  writeFileSync(sourcePath, source);
  initializePreparation(paths, 'Use src/hold.ts');
  recordPreparationRead(paths, 'explore', 'src/hold.ts', source);
  return { paths, sourcePath, source };
}

describe('preparationSourceFacts', () => {
  it('passes only current source cards successfully read during exploration', () => {
    const { paths, source } = setup();
    const facts = preparationSourceFacts(paths);
    ok(facts?.includes('src/hold.ts'));
    ok(facts?.includes(source.trim()));
  });

  it('surfaces exact value and non-mutation excerpts as concise citeable plan evidence', () => {
    const root = mkdtempSync(join(tmpdir(), 'sdlc-plan-invariants-'));
    roots.push(root);
    mkdirSync(join(root, 'src'), { recursive: true });
    mkdirSync(join(root, 'test'), { recursive: true });
    const paths = new WitokPaths(root, 'demo');
    const source = [
      '/**',
      ' * Hold is an immutable value and stores its own snapshot of the slot.',
      ' */',
      'export interface Hold { slot: Slot; }',
    ].join('\n');
    const tests = [
      "import { it } from 'node:test';",
      "it('does not mutate arguments and returns a new object', () => {",
      '  notStrictEqual(first, second);',
      '});',
    ].join('\n');
    writeFileSync(join(root, 'src', 'hold.ts'), source);
    writeFileSync(join(root, 'test', 'hold.test.ts'), tests);
    initializePreparation(paths, 'Use src/hold.ts and test/hold.test.ts');
    recordPreparationRead(paths, 'explore', 'src/hold.ts', source);
    recordPreparationRead(paths, 'explore', 'test/hold.test.ts', tests);
    const facts = preparationSourceFacts(paths) ?? '';
    ok(facts.includes('src/hold.ts:Hold'), facts);
    ok(facts.includes('test/hold.test.ts:does-not-mutate-arguments-and-returns-a-new-object'), facts);
    ok(facts.includes('own snapshot of the slot'), facts);
    ok(facts.includes('notStrictEqual(first, second)'), facts);
  });

  it('does not pass stale source text after the file changes', () => {
    const { paths, sourcePath } = setup();
    writeFileSync(sourcePath, 'export function changed() {}\n');
    strictEqual(preparationSourceFacts(paths), null);
  });

  it('feeds prior review findings into the next plan revision with a verification instruction', () => {
    const { paths } = setup();
    const state = preparation(paths)!;
    savePreparation(paths, {
      ...state,
      review: { fingerprint: 'previous', independent: 'The type documents snapshot semantics.', issues: ['Mutation violates the value contract.'], completed: true },
    });
    const facts = preparationReviewFacts(paths);
    ok(facts?.includes('Mutation violates the value contract.'));
    ok(facts?.includes('Сверь каждое замечание с исходным запросом'));
  });
});
