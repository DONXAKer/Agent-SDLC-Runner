/**
 * `stages/entry.ts::entryProblems` — блокеры входа этапа с виновником, вынесенные из
 * `Run.blockerDetails`, чтобы дашборд считал их по диску без `Run`.
 */

import { ok, strictEqual } from 'node:assert/strict';
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, describe, it } from 'node:test';

import { writeArtifact } from '../src/artifacts/artifact.ts';
import { WitokPaths } from '../src/artifacts/paths.ts';
import { entryProblems, planFilesOnDisk } from '../src/run/stages/entry.ts';
import type { StageContext } from '../src/run/stages/types.ts';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'sdlc-entry-test-')));
after(() => rmSync(root, { recursive: true, force: true }));

const ctx: StageContext = { paths: new WitokPaths(root, 'w'), chunk: 1, attempt: 1 };

describe('entryProblems', () => {
  it('нет набора гейтов — блокер каждого этапа кроме intent, виновник intent', () => {
    const problems = entryProblems('explore', ctx, null);
    const gates = problems.find((p) => p.text.includes('нет набора гейтов'));
    ok(gates !== undefined, 'нет блокера про набор гейтов');
    strictEqual(gates.blamed, 'intent');
    ok(!entryProblems('intent', ctx, null).some((p) => p.text.includes('нет набора гейтов')));
  });

  it('объявленный обрыв handoff набором гейтов не запирается', () => {
    ok(entryProblems('handoff', ctx, null).some((p) => p.text.includes('нет набора гейтов')));
    ok(!entryProblems('handoff', ctx, null, { abortHandoff: true }).some((p) => p.text.includes('нет набора гейтов')));
  });

  it('план без files_to_touch — блокер chunk, виновник plan', () => {
    writeArtifact(ctx.paths.plan, '# План\n\nничего не трогаем\n');
    const p = entryProblems('chunk', ctx, null).find((x) => x.text.includes('files_to_touch пуст'));
    ok(p !== undefined, 'нет блокера про пустой files_to_touch');
    strictEqual(p.blamed, 'plan');
    strictEqual(planFilesOnDisk(ctx, 'chunk')?.length, 0);
    strictEqual(planFilesOnDisk(ctx, 'plan'), null);
  });

  it('withBlame: false — виновник не считается', () => {
    ok(entryProblems('chunk', ctx, null, { withBlame: false }).every((p) => p.blamed === null));
  });

  it('Run.blockerDetails — делегат, второй копии проверок в Run.ts нет', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const text = readFileSync(join(here, '..', 'src', 'run', 'Run.ts'), 'utf8');
    ok(!/configProblems\(/.test(text), 'Run.ts снова зовёт configProblems сам');
    ok(!/unimplementedGates\(/.test(text), 'Run.ts снова зовёт unimplementedGates сам');
  });
});
