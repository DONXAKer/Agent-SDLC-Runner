import { strictEqual, ok } from 'node:assert/strict';
import { describe, it } from 'node:test';
import { normalizePreparationTables } from '../src/artifacts/preparation.ts';

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
});
