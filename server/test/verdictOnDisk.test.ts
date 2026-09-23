/**
 * Вердикт этапа 6 на диске (code-review-all 2026-09-23): рантайм пишет его в секцию
 * «Вердикт» отчёта приёмки, а handoff и восстановление попытки читают его оттуда.
 * Прежде строка бланка `- **passed:** true / false` проходила проверку «передача
 * разрешена» — handoff с коммитом открывался на незаполненном отчёте.
 */

import { strictEqual } from 'node:assert/strict';
import { describe, it } from 'node:test';

import { readReportVerdict, writeVerdictSection } from '../src/run/verifyAutofill.ts';

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

describe('readReportVerdict', () => {
  it('бланк, проза и таблица — не вердикт', () => {
    strictEqual(readReportVerdict(BLANK), null);
    strictEqual(readReportVerdict('в шаблоне написано passed: true'), null);
  });

  it('одно значение — вердикт; жирность и маркер списка прощаются', () => {
    strictEqual(readReportVerdict('- **passed:** true'), 'passed');
    strictEqual(readReportVerdict('- passed: false'), 'failed');
    strictEqual(readReportVerdict('passed: **true**'), 'passed');
  });
});

describe('writeVerdictSection', () => {
  it('зелёный вердикт пишется в бланк и читается обратно', () => {
    const { text, changed } = writeVerdictSection(BLANK, { passed: true, action: 'continue', reasons: [] });
    strictEqual(changed, true);
    strictEqual(readReportVerdict(text), 'passed');
    strictEqual(text.includes('- **action:** continue'), true, text);
    strictEqual(text.includes('- **По каким условиям упал:** н/п'), true, text);
    // Строка сверки с деревом и таблица пунктов не тронуты.
    strictEqual(text.includes('**нет — passed=false**'), true);
  });

  it('красный вердикт — passed false, action и причины', () => {
    const { text } = writeVerdictSection(BLANK, { passed: false, action: 'retry', reasons: ['гейт «Тесты» ❌'] });
    strictEqual(readReportVerdict(text), 'failed');
    strictEqual(text.includes('- **action:** retry'), true, text);
    strictEqual(text.includes('гейт «Тесты» ❌'), true);
  });

  it('CRLF сохраняется', () => {
    const { text } = writeVerdictSection(BLANK.replace(/\n/g, '\r\n'), { passed: true, action: 'continue', reasons: [] });
    strictEqual(text.includes('- **passed:** true\r\n'), true);
  });

  it('секции «Вердикт» нет — текст не трогается', () => {
    strictEqual(writeVerdictSection('# пусто', { passed: true, action: 'continue', reasons: [] }).changed, false);
  });
});
