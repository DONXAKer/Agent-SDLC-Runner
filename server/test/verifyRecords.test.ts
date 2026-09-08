/**
 * Структурированный канал вывода этапа 6: `RecordClaim` / `RecordFinding`.
 *
 * Меряется одно: отчёт, собранный рантаймом из записей, обязан разбираться тем же
 * `readReport`, которым считается вердикт. Пока форму отчёта писала модель, её ошибка
 * оформления стоила ровно столько же, сколько несделанная работа: колонка `№` вместо
 * `id` — и «в отчёте не прочитан ни один пункт», вердикт по пустому входу.
 */

import { deepStrictEqual, ok, strictEqual } from 'node:assert/strict';
import { describe, it } from 'node:test';

import { normalize } from '../src/exec/normalize.ts';
import { acceptedClaimStatus, anchorFound, renderRecords, verifyReportGaps } from '../src/run/verifyReport.ts';
import { readReport } from '../src/verdict/collect.ts';

describe('нормализация записей', () => {
  it('RecordClaim приводит id и статус к канону', () => {
    const call = normalize('RecordClaim', {
      id: 'Claim-3',
      status: 'passed',
      evidence: 'src/tariffs.ts:priceFor',
    });
    deepStrictEqual(call, {
      kind: 'record_claim',
      id: 'claim-3',
      status: '✅',
      evidence: 'src/tariffs.ts:priceFor',
      whatToFix: null,
    });
  });

  it('голый номер — тот же пункт', () => {
    const call = normalize('record_claim', { id: '4', status: '❌', evidence: 'x.ts' });
    strictEqual(call.kind === 'record_claim' && call.id, 'claim-4');
  });

  it('пятой градации нет: «частично» уходит в unknown, а не в свой статус', () => {
    // Таблица вердикта знает четыре значения. Принять пятое значило бы завести его молча.
    const call = normalize('RecordClaim', { id: 'claim-1', status: 'частично', evidence: 'x' });
    strictEqual(call.kind, 'unknown');
  });

  it('запись без доказательства не принимается', () => {
    strictEqual(normalize('RecordClaim', { id: 'claim-1', status: '✅' }).kind, 'unknown');
  });

  it('RecordFinding принимает только объявленные секции', () => {
    strictEqual(normalize('RecordFinding', { section: 'review', text: 'X' }).kind, 'record_finding');
    strictEqual(normalize('RecordFinding', { section: 'мысли', text: 'X' }).kind, 'unknown');
  });

  it('имя MCP-инструмента флоу sdk даёт тот же вызов, что имя флоу loop', () => {
    // Тот же инвариант, что стережёт conformance: различия имён имеют значение ровно
    // в одном месте — здесь.
    const loop = normalize('RecordFinding', { section: 'regression', text: 'X', evidence: 'y.ts' });
    const sdk = normalize('mcp__sdlc__record_finding', {
      section: 'regression',
      text: 'X',
      evidence: 'y.ts',
    });
    deepStrictEqual(loop, sdk);
  });
});

const TEMPLATE = [
  '# Отчёт приёмки',
  '',
  '## 1. Пункты приёмки',
  '',
  '| id | Пункт | passed | Чем подтверждён | Что чинить |',
  '|---|---|---|---|---|',
  '| claim-1 | надбавка считается… | ‹✅/❌/⚠› | ‹место› | ‹что чинить› |',
  '',
  '## 2. Ревью: что искали опровергнуть',
  '',
  '_подсказка формы_',
  '- Подтверждённое расхождение: н/п',
  '',
  '## 3. Scope',
  '',
  '- Файлы вне плана: нет',
  '',
  '## 4. Инварианты',
  '',
  '- проектных инвариантов в задаче нет: н/п',
  '',
  '## 5. Регрессии',
  '',
  '- нет',
  '',
].join('\n');

describe('рендер отчёта из записей', () => {
  it('пункт с записью попадает в таблицу и читается разбором вердикта', () => {
    const { text, filled } = renderRecords(TEMPLATE, {
      claims: [{ id: 'claim-1', status: '❌', evidence: 'src/x.ts:priceFor', whatToFix: 'вернуть ставку' }],
      findings: [],
    });
    strictEqual(filled, 1);
    const facts = readReport(text);
    deepStrictEqual(facts.claims, [{ id: 'claim-1', status: '❌' }]);
    ok(text.includes('src/x.ts:priceFor'));
    // Текст пункта берётся из строки формы, а не пересказывается рецензентом.
    ok(text.includes('надбавка считается…'));
  });

  it('пункт, которого нет в форме, дописывается, а не теряется', () => {
    const { text } = renderRecords(TEMPLATE, {
      claims: [{ id: 'claim-7', status: '✅', evidence: 'test/a.test.ts', whatToFix: null }],
      findings: [],
    });
    const ids = readReport(text).claims.map((c) => c.id);
    ok(ids.includes('claim-7'), ids.join(','));
  });

  it('повторная запись того же пункта заменяет строку, а не двоит её', () => {
    const { text } = renderRecords(TEMPLATE, {
      claims: [{ id: 'claim-1', status: '✅', evidence: 'a.ts', whatToFix: null }],
      findings: [],
    });
    const again = renderRecords(text, {
      claims: [{ id: 'claim-1', status: '❌', evidence: 'a.ts', whatToFix: 'чинить' }],
      findings: [],
    });
    const claims = readReport(again.text).claims;
    deepStrictEqual(claims, [{ id: 'claim-1', status: '❌' }]);
  });

  it('находка ревью со ссылкой роняет вердикт по своему каналу', () => {
    const { text } = renderRecords(TEMPLATE, {
      claims: [],
      findings: [
        { section: 'review', text: 'скидка считается от базы с надбавкой', evidence: 'src/x.ts:42', anchored: true },
      ],
    });
    strictEqual(readReport(text).confirmedReviewFindings, 1);
  });

  it('инвариант и регрессия попадают каждый в свою секцию', () => {
    const { text } = renderRecords(TEMPLATE, {
      claims: [],
      findings: [
        { section: 'invariant', text: 'округление половины вверх', evidence: 'src/money.ts:percent', anchored: true },
        { section: 'regression', text: 'дальняя зона считается по чужому тарифу', evidence: 'src/zones.ts', anchored: true },
      ],
    });
    const facts = readReport(text);
    strictEqual(facts.brokenInvariants.length, 1);
    strictEqual(facts.regressions.length, 1);
  });

  it('находка БЕЗ привязки сохраняется, но в вердикт не идёт', () => {
    // Требование ссылки задумано против оформителя, закрывающего бланк вслепую, а не
    // против рецензента, который что-то увидел и не смог показать пальцем.
    const { text } = renderRecords(TEMPLATE, {
      claims: [],
      findings: [{ section: 'review', text: 'кажется, теряется копейка', evidence: '', anchored: false }],
    });
    ok(text.includes('кажется, теряется копейка'));
    strictEqual(readReport(text).confirmedReviewFindings, 0);
  });

  it('без записей отчёт не трогается вовсе', () => {
    const { text, filled } = renderRecords(TEMPLATE, { claims: [], findings: [] });
    strictEqual(filled, 0);
    strictEqual(text, TEMPLATE);
  });

  it('труба в доказательстве не разваливает таблицу', () => {
    const { text } = renderRecords(TEMPLATE, {
      claims: [{ id: 'claim-1', status: '✅', evidence: "grep 'a|b' src/x.ts", whatToFix: null }],
      findings: [],
    });
    deepStrictEqual(readReport(text).claims, [{ id: 'claim-1', status: '✅' }]);
  });
});

describe('проверка ссылки на место', () => {
  const patch = 'diff --git a/src/tariffs.ts b/src/tariffs.ts\n+export function surchargeFor(order: Order) {';

  it('имя файла из патча — привязка есть', () => {
    strictEqual(anchorFound('src/tariffs.ts:12', patch), true);
  });

  it('имя символа из патча — тоже', () => {
    strictEqual(anchorFound('функция surchargeFor', patch), true);
  });

  it('«проверено» привязкой не является', () => {
    strictEqual(anchorFound('проверено', patch), false);
  });

  it('пустая ссылка — не привязка', () => {
    strictEqual(anchorFound('', patch), false);
  });

  it('голые числа привязкой не считаются: они есть в любом диффе', () => {
    strictEqual(anchorFound('42', patch), false);
  });
});

describe('якорь: имя пункта местом не является (замер 2026-09-08, «оформитель»)', () => {
  const patch = 'diff --git a/test/oversize.test.ts b/test/oversize.test.ts\n+describe("claim-1", () => {';

  it('`test/x.ts:claim-1` держится на имени файла, а не на claim-1', () => {
    strictEqual(anchorFound('test/oversize.test.ts:claim-1', patch), true);
    // Тот же id без файла — привязки нет: план содержит каждый claim-N, и ссылка на
    // него находила себя всегда.
    strictEqual(anchorFound('claim-1', `${patch}\nplan: claim-1 — ставка 40%`), false);
  });
});

describe('статус при приёме записи', () => {
  it('зелёный без места в патче принимается как ⚠', () => {
    strictEqual(acceptedClaimStatus('✅', false), '⚠');
  });

  it('зелёный с местом остаётся зелёным', () => {
    strictEqual(acceptedClaimStatus('✅', true), '✅');
  });

  it('красный и ⚠ без места не меняются: увиденный дефект роняет вердикт и так', () => {
    strictEqual(acceptedClaimStatus('❌', false), '❌');
    strictEqual(acceptedClaimStatus('⚠', false), '⚠');
    strictEqual(acceptedClaimStatus('manual', false), 'manual');
  });
});

describe('текст пункта из листа задачи', () => {
  it('плейсхолдер строки-образца заменяется текстом пункта задачи', () => {
    const blank = TEMPLATE.replace('надбавка считается…', '‹начало пункта…›');
    const { text } = renderRecords(blank, {
      claims: [{ id: 'claim-1', status: '✅', evidence: 'src/x.ts', whatToFix: null }],
      findings: [],
      titles: new Map([['claim-1', 'надбавка 40% при стороне > 120 см']]),
    });
    ok(text.includes('надбавка 40% при стороне > 120 см'), text);
    ok(!text.includes('‹начало пункта…›'));
  });

  it('текст формы, написанный не плейсхолдером, не пересказывается', () => {
    const { text } = renderRecords(TEMPLATE, {
      claims: [{ id: 'claim-1', status: '✅', evidence: 'src/x.ts', whatToFix: null }],
      findings: [],
      titles: new Map([['claim-1', 'другая формулировка']]),
    });
    ok(text.includes('надбавка считается…'));
    ok(!text.includes('другая формулировка'));
  });

  it('дописанный пункт получает текст из листа задачи, а не прочерк', () => {
    const { text } = renderRecords(TEMPLATE, {
      claims: [{ id: 'claim-7', status: '✅', evidence: 'src/x.ts', whatToFix: null }],
      findings: [],
      titles: new Map([['claim-7', 'граница ровно 120 см']]),
    });
    ok(text.includes('| claim-7 | граница ровно 120 см |'), text);
  });
});

describe('пробелы отчёта по пунктам задачи (страж завершения этапа 6)', () => {
  it('строка с зелёным статусом и нетронутым текстом — пробел', () => {
    const report = TEMPLATE.replace(
      '| claim-1 | надбавка считается… | ‹✅/❌/⚠› | ‹место› | ‹что чинить› |',
      '| claim-1 | ‹начало пункта…› | ✅ | test/oversize.test.ts:claim-1 | н/п |',
    );
    const gaps = verifyReportGaps(report, ['claim-1']);
    strictEqual(gaps.length, 1);
    ok(/claim-1/.test(gaps[0]!) && /незаполненное место/.test(gaps[0]!), gaps.join('; '));
  });

  it('пункт задачи без строки в таблице — пробел', () => {
    const filled = renderRecords(TEMPLATE, {
      claims: [{ id: 'claim-1', status: '✅', evidence: 'src/x.ts', whatToFix: null }],
      findings: [],
    }).text;
    deepStrictEqual(verifyReportGaps(filled, ['claim-1', 'claim-2']), ['нет строки пункта claim-2']);
  });

  it('все пункты на месте и заполнены — пробелов нет', () => {
    const filled = renderRecords(TEMPLATE, {
      claims: [
        { id: 'claim-1', status: '✅', evidence: 'src/x.ts', whatToFix: null },
        { id: 'claim-2', status: '❌', evidence: 'src/y.ts', whatToFix: 'чинить' },
      ],
      findings: [],
    }).text;
    deepStrictEqual(verifyReportGaps(filled, ['claim-1', 'claim-2']), []);
  });

  it('строка-образец под чужой id — оформление, не содержание', () => {
    // В задаче нет claim-1 (лист начат с claim-2): образец шаблона стражу не принадлежит.
    const filled = renderRecords(TEMPLATE, {
      claims: [{ id: 'claim-2', status: '✅', evidence: 'src/x.ts', whatToFix: null }],
      findings: [],
    }).text;
    deepStrictEqual(verifyReportGaps(filled, ['claim-2']), []);
  });

  it('без списка задачи считаются только плейсхолдеры в строках пунктов', () => {
    strictEqual(verifyReportGaps(TEMPLATE, []).length, 1);
  });

  it('регистр id не мешает сверке', () => {
    const filled = renderRecords(TEMPLATE, {
      claims: [{ id: 'claim-1', status: '✅', evidence: 'src/x.ts', whatToFix: null }],
      findings: [],
    }).text;
    deepStrictEqual(verifyReportGaps(filled, ['Claim-1']), []);
  });
});
