/**
 * Вердикт этапа 6 на диске (code-review-all 2026-09-23). Решения — handoff (коммит!),
 * предусловие chunk, `/advance`, рестарт — принимаются по служебному файлу попытки
 * (`verdictStore.ts`), закрытому от записи моделью. Секция «Вердикт» отчёта — копия для
 * человека: отчёт пишет и модель, и её `- passed: true`, записанный до отмены этапа,
 * прежде открывал handoff с коммитом непроверенного витка.
 */

import { ok, strictEqual } from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import type { NormalizedCall, PolicyContext } from '@sdlc-runner/shared';

import { WitokPaths } from '../src/artifacts/paths.ts';
import { evaluate } from '../src/policy/index.ts';
import { chunkStage } from '../src/run/stages/chunk/index.ts';
import { handoffStage } from '../src/run/stages/handoff.ts';
import type { StageContext } from '../src/run/stages/types.ts';
import { clearRunVerdict, readRunVerdict, writeRunVerdict } from '../src/run/verdictStore.ts';
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

describe('служебный файл вердикта', () => {
  const root = mkdtempSync(join(tmpdir(), 'verdict-store-'));
  after(() => rmSync(root, { recursive: true, force: true }));
  const paths = new WitokPaths(root, 'demo');
  mkdirSync(paths.dir, { recursive: true });
  const ctx = (attempt: number): StageContext => ({ paths, chunk: 1, attempt });
  const handoffGate = handoffStage.requires[0]!;
  const chunkGate = chunkStage.requires.find((r) => r.describe.includes('не проверена вердиктом'))!;

  it('пишется, читается, снимается; битый файл — не вердикт', () => {
    writeRunVerdict(paths, 1, 1, { passed: false, action: 'escalate', reasons: ['бюджет'] });
    strictEqual(readRunVerdict(paths, 1, 1)?.action, 'escalate');
    clearRunVerdict(paths, 1, 1);
    strictEqual(readRunVerdict(paths, 1, 1), null);
    writeFileSync(paths.verdictFile(1, 1), '{"passed": "true"}');
    strictEqual(readRunVerdict(paths, 1, 1), null);
    clearRunVerdict(paths, 1, 1);
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
    ok(!evaluate(write('.sdlc/demo/.chunk-1-attempt-1-verdict.json'), pctx).ok);
    ok(!evaluate(write('.sdlc/demo/metrics.json'), pctx).ok);
    ok(!evaluate({ kind: 'bash', command: 'echo {} > .sdlc/demo/.chunk-1-attempt-1-verdict.json' }, pctx).ok);
    ok(evaluate(write('.sdlc/demo/verification-report-1-attempt-1.md'), pctx).ok);
  });
});
