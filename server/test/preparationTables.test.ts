import { strictEqual, ok } from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  materializeAcceptanceSeed,
  mergeAcceptanceSeedAnswer,
  normalizePreparationTables,
  seedAcceptanceFromRequests,
  seedBasisFromRequests,
} from '../src/artifacts/preparation.ts';
import { parseTables } from '../src/md/table.ts';

const template = [
  '## Приёмочный лист',
  '<!-- sdlc-json:acceptance:start -->',
  '‹acceptance_json›',
  '<!-- sdlc-json:acceptance:end -->',
  '## Основания и сценарии',
  '<!-- sdlc-json:basis:start -->',
  '‹basis_json›',
  '<!-- sdlc-json:basis:end -->',
].join('\n');

describe('preparation JSON table rendering', () => {
  it('validates matching claim IDs and renders Markdown with escaped cell delimiters', () => {
    const input = template
      .replace('‹acceptance_json›', JSON.stringify([{ id: 'claim-1', behavior: 'moveHold exists', procedure: 'inspect src/hold.ts', expected: 'one | exported function' }]))
      .replace('‹basis_json›', JSON.stringify([{ id: 'claim-1', basis: 'request', scenario: 'move hold', counterexample: 'new id' }]));
    const result = normalizePreparationTables(input);
    strictEqual(result.problem, null);
    strictEqual(result.changed, true);
    ok(result.text.includes('| claim-1 | moveHold exists | Процедура: inspect src/hold.ts. Ожидаемо: one \\| exported function |'));
    ok(result.text.includes('| request | move hold | new id | claim-1 |'));
    ok(!result.text.includes('sdlc-json:acceptance'));
  });

  it('rejects malformed JSON and duplicate or mismatched IDs', () => {
    const malformed = normalizePreparationTables(template.replace('‹acceptance_json›', '{bad json}'));
    ok(malformed.problem?.includes('JSON-массив'));

    const acceptance = JSON.stringify([
      { id: 'claim-1', behavior: 'a', procedure: 'b', expected: 'c' },
      { id: 'claim-1', behavior: 'd', procedure: 'e', expected: 'f' },
    ]);
    const duplicate = normalizePreparationTables(template.replace('‹acceptance_json›', acceptance));
    ok(duplicate.problem?.includes('уникальные ID'));

    const mismatch = normalizePreparationTables(template
      .replace('‹acceptance_json›', JSON.stringify([{ id: 'claim-1', behavior: 'a', procedure: 'b', expected: 'c' }]))
      .replace('‹basis_json›', JSON.stringify([{ id: 'claim-2', basis: 'a', scenario: 'b', counterexample: 'c' }])));
    ok(mismatch.problem?.includes('одинаковый набор claim-N'));
  });

  it('requires marked JSON blocks for newly seeded v2 claim tables', () => {
    const directMarkdown = '## Приёмочный лист\n| ID | Пункт | Проверка |\n|---|---|---|\n| claim-1 | behavior | test |';
    ok(normalizePreparationTables(directMarkdown, true).problem?.includes('Восстанови оба блока JSON-маркерами'));
  });

  it('normalizes a complete legacy Markdown pair into Runner-rendered tables', () => {
    const markdown = [
      '# Приёмочный лист',
      '| id | Пункт | Как проверить |',
      '|---|---|---|',
      '| claim-1 | behavior | run test |',
      '# Основания и сценарии',
      '| id | Основание | Сценарий | Контрпример | ID |',
      '|---|---|---|---|---|',
      '| claim-1 | request | move hold | new id | claim-1 |',
    ].join('\n');
    const result = normalizePreparationTables(markdown, true);
    strictEqual(result.problem, null);
    strictEqual(result.changed, true);
    ok(result.text.includes('| ID | Пункт | Как проверить'));
    ok(result.text.includes('| request | move hold | new id | claim-1 |'));
    ok(!result.text.includes('sdlc-json:acceptance'));
    ok(result.text.includes('\n# Основания и сценарии\n'), 'рендер не склеивает следующую секцию с последней строкой таблицы');
    const repeated = normalizePreparationTables(result.text, true);
    strictEqual(repeated.problem, null);
    strictEqual(repeated.text, result.text, 'повторный finishGuard не меняет требования и их отпечаток');
  });

  it('closes a code span cut by the basis lines window so the row keeps its cells', () => {
    // Точная цитата claim-5 из guided-sample-20261006205009382 m1-t2-r3: окно lines:[17,17]
    // обрезало строку запроса внутри inline-кода (`{ ok: false; reason }` распался), и без
    // добивки кавычки splitRow глотал все «|» до конца строки — ID требования терялся.
    const quote = 'request-1:L17-L17 «`IssueResult` — той же формы, что `ReserveResult`: `{ ok: true }` либо `{ ok: false;»';
    const input = template
      .replace('‹acceptance_json›', JSON.stringify([{ id: 'claim-5', behavior: 'a', procedure: 'b', expected: 'c' }]))
      .replace('‹basis_json›', JSON.stringify([{ id: 'claim-5', basis: quote, scenario: 's', counterexample: 'k' }]));
    const result = normalizePreparationTables(input);
    strictEqual(result.problem, null);
    const table = parseTables(result.text).find((t) => t.section === 'Основания и сценарии');
    ok(table, 'таблица оснований отрендерена');
    strictEqual(table.rows.length, 1);
    strictEqual(table.rows[0]!.length, 4, 'строка разбирается на четыре ячейки, а не схлопывается в одну');
    strictEqual(table.rows[0]![3], 'claim-5');
  });

  it('closes an unclosed code span in a legacy basis table before parsing rows', () => {
    // guided-sample-20261006205009382 m1-t2-r3: модель сформировала markdown-таблицу,
    // в которой цитата в основании содержала незакрытый inline-код (`{ ok: false;`).
    // canonicalizeMarkdownClaimTables должна закрыть его перед splitRow, иначе все «|»
    // становятся частью ячейки и ID требования теряется.
    const markdown = [
      '# Приёмочный лист',
      '| id | Пункт | Как проверить |',
      '|---|---|---|',
      '| claim-5 | behavior | run test |',
      '# Основания и сценарии',
      '| Основание | Сценарий | Контрпример | ID |',
      '|---|---|---|---|',
      '| request-1:L17-L17 «`IssueResult` — той же формы, что `ReserveResult`: `{ ok: true }` либо `{ ok: false;» | s | k | claim-5 |',
    ].join('\n');
    const result = normalizePreparationTables(markdown, true);
    strictEqual(result.problem, null);
    const table = parseTables(result.text).find((t) => t.section === 'Основания и сценарии');
    ok(table);
    strictEqual(table.rows.length, 1);
    strictEqual(table.rows[0]!.length, 4);
    strictEqual(table.rows[0]![3], 'claim-5');
  });

  it('derives basis rows from acceptance when basis marker is missing', () => {
    const request = 'Реализовать moveHold.\nДобавить тест.';
    const input = template.replace('‹acceptance_json›', JSON.stringify([{ id: 'claim-1', behavior: 'moveHold exists', procedure: 'inspect src/hold.ts', expected: 'function exported' }])).replace(/## Основания и сценарии\n<!-- sdlc-json:basis:start -->\n‹basis_json›\n<!-- sdlc-json:basis:end -->/u, '');
    const result = normalizePreparationTables(input, true, [request]);
    strictEqual(result.problem, null);
    strictEqual(result.changed, true);
    ok(result.text.includes('## Основания и сценарии'));
    ok(result.text.includes('| request-1:L1-L2 | Когда moveHold exists | Когда moveHold exists не требуется | claim-1 |'));
    const table = parseTables(result.text).find((t) => t.section === 'Основания и сценарии');
    ok(table);
    strictEqual(table.rows.length, 1);
    strictEqual(table.rows[0]![3], 'claim-1');
  });

  it('derives basis rows when basis JSON is empty or unparseable', () => {
    const request = 'Реализовать moveHold.';
    const acceptance = JSON.stringify([{ id: 'claim-1', behavior: 'moveHold exists', procedure: 'inspect src/hold.ts', expected: 'function exported' }]);
    for (const basisJson of ['[]', '{bad json}', JSON.stringify([{ id: 'claim-1' }])]) {
      const input = template.replace('‹acceptance_json›', acceptance).replace('‹basis_json›', basisJson);
      const result = normalizePreparationTables(input, true, [request]);
      strictEqual(result.problem, null, `basis JSON ${basisJson} should fallback`);
      strictEqual(result.changed, true);
      ok(result.text.includes('| request-1:L1-L1 | Когда moveHold exists | Когда moveHold exists не требуется | claim-1 |'));
    }
  });

  it('keeps an authored basis table when it is valid', () => {
    const input = template
      .replace('‹acceptance_json›', JSON.stringify([{ id: 'claim-1', behavior: 'moveHold exists', procedure: 'inspect src/hold.ts', expected: 'function exported' }]))
      .replace('‹basis_json›', JSON.stringify([{ id: 'claim-1', basis: 'request-1:L1-L1', scenario: 's', counterexample: 'k' }]));
    const result = normalizePreparationTables(input, true, ['request']);
    strictEqual(result.problem, null);
    strictEqual(result.changed, true);
    ok(result.text.includes('| request-1:L1-L1 | s | k | claim-1 |'));
    ok(!result.text.includes('Когда moveHold exists'));
  });

  it('salvages truncated acceptance JSON inside markers', () => {
    const truncated = '[{"id":"claim-1","behavior":"ok","procedure":"run","expected":"pass"}';
    const input = template.replace('‹acceptance_json›', truncated)
      .replace('‹basis_json›', JSON.stringify([{ id: 'claim-1', basis: 'request-1:L1-L1', scenario: 's', counterexample: 'k' }]));
    const result = normalizePreparationTables(input, true, ['request']);
    strictEqual(result.problem, null, result.problem ?? undefined);
    ok(result.text.includes('| claim-1 | ok |'));
  });

  it('names an unfilled acceptance placeholder explicitly', () => {
    const result = normalizePreparationTables(template, true);
    ok(result.problem?.includes('ещё не заполнен'));
  });

  it('seeds acceptance id/behavior from numbered request items and merges procedure/expected', () => {
    const request = [
      '## Что должно получиться',
      '',
      '1. Функция `canonSku` обрезает пробелы и поднимает регистр.',
      '2. Канонизация на всех границах пакета.',
      '3. Тест рядом с существующими.',
      '',
      '## Рамки',
      '- README не трогаем',
    ].join('\n');
    const seeds = seedAcceptanceFromRequests([request]);
    strictEqual(seeds.length, 3);
    strictEqual(seeds[0]?.id, 'claim-1');
    ok(seeds[0]?.behavior.includes('canonSku'));
    strictEqual(seeds[0]?.procedure, '');
    const merged = mergeAcceptanceSeedAnswer(seeds, JSON.stringify([
      { id: 'claim-1', procedure: 'вызвать canonSku', expected: 'верхний регистр' },
      { id: 'claim-2', procedure: 'проход границ', expected: 'грязный код найден' },
    ]));
    ok(merged !== null);
    const rows = JSON.parse(merged!) as { id: string; behavior: string; procedure: string; expected: string }[];
    strictEqual(rows.length, 3);
    strictEqual(rows[0]?.behavior, seeds[0]?.behavior);
    strictEqual(rows[0]?.procedure, 'вызвать canonSku');
    ok(rows[2]?.procedure.startsWith('Проверить по запросу:'));
    ok(rows[2]?.expected.includes('Соответствует пункту'));
    const material = materializeAcceptanceSeed(seeds);
    ok(material.every((row) => row.procedure !== '' && row.expected !== '' && !/[‹›]/u.test(row.procedure)));
  });

  it('seeds basis rows with request line addresses and quotes for each acceptance claim', () => {
    const request = [
      '## Что должно получиться',
      '',
      '1. Функция `canonSku` обрезает пробелы',
      '   и поднимает регистр.',
      '2. Канонизация на всех границах пакета.',
    ].join('\n');
    const seeds = seedAcceptanceFromRequests([request]);
    const basis = seedBasisFromRequests(seeds, [request]);
    strictEqual(basis.length, 2);
    strictEqual(basis[0]?.id, 'claim-1');
    ok(basis[0]!.basis.startsWith('request-1:L3-L4 «'), basis[0]!.basis);
    ok(basis[0]!.basis.includes('canonSku'));
    ok(basis[1]!.basis.startsWith('request-1:L5-L5 «'), basis[1]!.basis);
    ok(basis.every((row) => row.scenario !== '' && row.counterexample !== '' && !/[‹›]/u.test(row.basis)));
    // Пункт, не найденный построчно, получает адрес всего запроса — не плейсхолдер.
    const unknown = seedBasisFromRequests([{ id: 'claim-9', behavior: 'Нечто совсем иное из другого источника' }], [request]);
    ok(unknown[0]!.basis.startsWith('request-1:L1-L5 «'), unknown[0]!.basis);
  });
});
