/**
 * Вердикт этапа 6 (code-review-all 2026-09-23). Решения — handoff (коммит!), предусловие
 * chunk, `/advance`, рестарт — принимаются по вердикту в состоянии рантайма вне проекта
 * (`verdictStore.ts`). Секция «Вердикт» отчёта — копия для человека: отчёт пишет и модель,
 * и её `- passed: true`, записанный до отмены этапа, прежде открывал handoff с коммитом
 * непроверенного витка.
 */

import { ok, strictEqual } from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { after, describe, it } from 'node:test';

import type { NormalizedCall, PolicyContext } from '@sdlc-runner/shared';

import { WitokPaths } from '../src/artifacts/paths.ts';
import { evaluate } from '../src/policy/index.ts';
import { chunkStage } from '../src/run/stages/chunk/index.ts';
import { handoffStage } from '../src/run/stages/handoff.ts';
import type { StageContext } from '../src/run/stages/types.ts';
import { markCommitted, patchShaOf, readRunVerdict, stalePatchReason, verdictPath, writeRunVerdict } from '../src/run/verdictStore.ts';
import { writeVerdictSection } from '../src/run/verifyAutofill.ts';

const BLANK = [
  '# Отчёт',
  '',
  '- **Сверка с деревом:** перегенерированный `git diff` совпал с патчем: да / **нет — passed=false**',
  '',
  '| id | Пункт | passed | Чем подтверждён | Что чинить |',
  '|---|---|---|---|---|',
  '',
  '## Вердикт',
  '',
  '- **passed:** true / false',
  '- **По каким условиям упал:** ‹перечислить› / н/п',
  '- **action:** continue / retry / blocked_env / escalate',
  '- **Попытка:** ‹K› из ‹бюджет›',
  '',
].join('\n');

describe('writeVerdictSection — копия вердикта в отчёте', () => {
  it('зелёный вердикт пишется в бланк; заметки не превращаются в «упал по…»', () => {
    const { text, changed, found } = writeVerdictSection(BLANK, {
      passed: true,
      action: 'continue',
      reasons: ['гейты посевом не проверялись'],
    });
    strictEqual(changed, true);
    strictEqual(found, true);
    ok(text.includes('- **passed:** true\n'), text);
    ok(text.includes('- **action:** continue'), text);
    ok(text.includes('- **По каким условиям упал:** н/п'), text);
    // Строка сверки с деревом и таблица пунктов не тронуты.
    ok(text.includes('**нет — passed=false**'));
  });

  it('красный вердикт — passed false, action и причины', () => {
    const { text } = writeVerdictSection(BLANK, { passed: false, action: 'retry', reasons: ['гейт «Тесты» ❌'] });
    ok(text.includes('- **passed:** false'), text);
    ok(text.includes('- **action:** retry'), text);
    ok(text.includes('гейт «Тесты» ❌'));
  });

  it('CRLF сохраняется; нумерованный заголовок секции узнаётся', () => {
    const { text } = writeVerdictSection(BLANK.replace(/\n/g, '\r\n'), { passed: true, action: 'continue', reasons: [] });
    ok(text.includes('- **passed:** true\r\n'));
    ok(writeVerdictSection(BLANK.replace('## Вердикт', '## 6. Вердикт'), { passed: true, action: 'continue', reasons: [] }).found);
  });

  it('секции нет — текст не трогается и об этом известно (found: false)', () => {
    const r = writeVerdictSection('# пусто', { passed: true, action: 'continue', reasons: [] });
    strictEqual(r.changed, false);
    strictEqual(r.found, false);
  });
});

describe('вердикт попытки в состоянии рантайма', () => {
  const root = mkdtempSync(join(tmpdir(), 'verdict-store-'));
  const prevState = process.env['SDLC_STATE_DIR'];
  process.env['SDLC_STATE_DIR'] = join(root, 'state');
  after(() => {
    if (prevState === undefined) delete process.env['SDLC_STATE_DIR'];
    else process.env['SDLC_STATE_DIR'] = prevState;
    rmSync(root, { recursive: true, force: true });
  });
  const project = join(root, 'proj');
  const paths = new WitokPaths(project, 'demo');
  mkdirSync(paths.dir, { recursive: true });
  const ctx = (attempt: number): StageContext => ({ paths, chunk: 1, attempt });
  const handoffGate = handoffStage.requires[0]!;
  const chunkGate = chunkStage.requires.find((r) => r.describe.includes('не проверена вердиктом'))!;

  it('лежит вне проекта; битый файл и файл другой попытки — не вердикт', () => {
    writeRunVerdict(paths, 1, 1, { passed: false, action: 'escalate', reasons: ['бюджет'] });
    strictEqual(readRunVerdict(paths, 1, 1)?.action, 'escalate');
    const file = verdictPath(paths, 1, 1);
    ok(file.startsWith(join(root, 'state')), file);
    ok(relative(project, file).startsWith('..'), 'вне дерева проекта — инструментам модели недосягаем');
    copyFileSync(file, verdictPath(paths, 1, 9));
    strictEqual(readRunVerdict(paths, 1, 9), null, 'копия под чужой попыткой не читается');
    writeFileSync(file, '{"passed": "true"}');
    strictEqual(readRunVerdict(paths, 1, 1), null);
  });

  it('вердикт привязан к патчу; после коммита патч не сверяется', () => {
    writeFileSync(paths.chunkDiff(1, 4), 'diff --git a/x b/x\n');
    writeRunVerdict(paths, 1, 4, { passed: true, action: 'continue', reasons: [] });
    const v = readRunVerdict(paths, 1, 4)!;
    strictEqual(v.patchSha, patchShaOf(paths, 1, 4));
    strictEqual(stalePatchReason(paths, 1, 4, v), null);
    strictEqual(handoffGate.check!(ctx(4)), null);
    writeFileSync(paths.chunkDiff(1, 4), 'diff --git a/y b/y\n');
    ok(handoffGate.check!(ctx(4))?.includes('изменён после вердикта'), 'устаревший вердикт не открывает handoff');
    markCommitted(paths, 1, 4, 'abc123');
    strictEqual(readRunVerdict(paths, 1, 4)?.committedSha, 'abc123');
    strictEqual(handoffGate.check!(ctx(4)), null, 'после коммита повторный вход в handoff открыт');
  });

  it('виток до вердикта в рантайме: попытка из iterations.md бережётся от chunk', () => {
    mkdirSync(paths.runnerDir, { recursive: true });
    writeFileSync(
      paths.iterations,
      '| Когда | Chunk | Попытка | Исход | Файлов | Строк | Совпадение с прошлым | Причины | Заметка |\n' +
        '|---|---|---|---|---|---|---|---|---|\n' +
        '| 2026-09-20 10:00 | 1 | 5 | ❌ retry | 1 | 2 | — | гейт | |\n',
    );
    ok(chunkGate.check!(ctx(5))?.includes('повтори verify'));
    strictEqual(chunkGate.check!(ctx(6)), null);
  });

  it('handoff: `passed: true` модели в отчёте без вердикта рантайма передачу не открывает', () => {
    writeFileSync(paths.verificationReport(1, 2), BLANK.replace('- **passed:** true / false', '- **passed:** true'));
    const why = handoffGate.check!(ctx(2));
    ok(why !== null && why.includes('вердикта рантайма'), String(why));
    writeRunVerdict(paths, 1, 2, { passed: true, action: 'continue', reasons: [] });
    strictEqual(handoffGate.check!(ctx(2)), null);
    writeRunVerdict(paths, 1, 2, { passed: false, action: 'retry', reasons: ['x'] });
    ok(handoffGate.check!(ctx(2))?.includes('не passed=true'));
  });

  it('chunk не перезаписывает попытку ни после красного, ни после зелёного вердикта', () => {
    strictEqual(chunkGate.check!(ctx(3)), null);
    writeRunVerdict(paths, 1, 3, { passed: true, action: 'continue', reasons: [] });
    ok(chunkGate.check!(ctx(3))?.includes('уже принята'));
    writeRunVerdict(paths, 1, 3, { passed: false, action: 'retry', reasons: ['x'] });
    ok(chunkGate.check!(ctx(3))?.includes('«Новая попытка»'));
  });

  it('служебные файлы каталога витка модели на запись закрыты; артефакты — нет', () => {
    const pctx: PolicyContext = {
      projectRoot: 'D:/work/proj',
      stage: 'verify',
      sdlcDir: '.sdlc/demo',
      planFiles: ['src/a.ts'],
      protectedArtifacts: [],
      readOnlyRoots: [],
      allowedTools: ['Write', 'Bash'],
      mcpTools: [],
    };
    const write = (path: string): NormalizedCall => ({ kind: 'write', path, content: '{}' });
    ok(!evaluate(write('.sdlc/demo/.events.ndjson'), pctx).ok);
    ok(!evaluate(write('.sdlc/demo/metrics.json'), pctx).ok);
    ok(evaluate(write('.sdlc/demo/verification-report-1-attempt-1.md'), pctx).ok);
  });
});
