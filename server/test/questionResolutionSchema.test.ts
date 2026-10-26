import { test } from 'node:test';
import { equal, throws } from 'node:assert/strict';
import { z } from 'zod';
import { buildQuestionEvidenceCatalog, numberQuestionSourceLines, questionResponseFormat, resolveQuestionEvidence, verifyQuestionCitation } from '../src/exec/guidedQuestions.ts';

const selected = { 'request-1': 'The public contract is explicitly specified.' };
const catalog = buildQuestionEvidenceCatalog(selected);
const evidenceId = catalog[0]!.id;
const schema = (question: string) => z.fromJSONSchema((questionResponseFormat(selected, [], question).json_schema as { schema: Record<string, unknown> }).schema);
const engineering = { kind: 'engineering', evidenceId, category: 'implementation_detail', choice: 'helper', reason: 'internal detail' };

test('resolver cannot propose an engineering choice forbidden by the question policy', () => {
  const publicContract = schema('Как изменить публичный контракт?');
  throws(() => publicContract.parse(engineering));
  publicContract.parse({ kind: 'source', evidenceId, answer: 'Follow the explicit contract' });
  equal(publicContract.safeParse({ kind: 'source', evidenceId: 'unknown', answer: 'Follow the explicit contract' }).success, false);
  equal(publicContract.safeParse({ kind: 'source', source: 'request-1', lines: [1, 1], answer: 'Follow the explicit contract' }).success, false);
  publicContract.parse({ kind: 'human', missingDecision: 'policy', options: ['one', 'two'], consequence: 'different behavior', reason: 'not specified' });
});

test('internal implementation and test naming retain only the allowed engineering categories', () => {
  schema('Как назвать внутренний helper?').parse(engineering);
  const naming = schema('Как назвать тест?');
  naming.parse({ ...engineering, category: 'test_name' });
  equal(naming.safeParse({ ...engineering, category: 'comment' }).success, false);
  equal(schema('What is the internal helper name?').safeParse({ kind: 'human', missingDecision: 'name', options: ['one', 'two'], consequence: 'style', reason: 'unknown name' }).success, false);
});

test('model-facing source lines carry evidence IDs and one-based addresses without changing line count', () => {
  const source = 'first\nsecond\n\nfourth';
  const ids = buildQuestionEvidenceCatalog({ 'request-1': source }).map(item => item.id);
  equal(numberQuestionSourceLines(source, ids), `${ids[0]} | 1 | first\n${ids[1]} | 2 | second\n${ids[2]} | 3 | \n${ids[3]} | 4 | fourth`);
});

test('internal data-structure questions allow a grounded engineering choice without deciding external contracts', () => {
  schema('Как структурировать Map для хранения ключей и состояния?').parse(engineering);
  throws(() => schema('Как изменить публичный контракт структуры данных?').parse(engineering));
  throws(() => schema('What data structure should the API response use?').parse(engineering));
  throws(() => schema('Как структурировать данные ответа сервиса?').parse(engineering));
});

test('citation relevance includes only the directly attached documentation, not the whole file', () => {
  const source = [
    '/**',
    ' * Общее правило округления для всего расчёта.',
    ' */',
    'export function percent(amount: number): number {',
    '  return Math.floor(amount + 0.5);',
    '}',
    '',
    'export function format(value: number): string {',
    '  return String(value);',
    '}',
  ].join('\n');
  const sources = new Map([['src/money.ts', source]]);
  const question = 'Как обработать округление по общему правилу пакета?';
  equal(verifyQuestionCitation(question, 'src/money.ts', [4, 6], sources), 'export function percent(amount: number): number {\n  return Math.floor(amount + 0.5);\n}');
  const evidenceCatalog = buildQuestionEvidenceCatalog({ 'src/money.ts': source });
  equal(resolveQuestionEvidence(question, evidenceCatalog[3]!.id, evidenceCatalog).quote, evidenceCatalog[3]!.excerpt);
  throws(() => verifyQuestionCitation(question, 'src/money.ts', [8, 10], sources), /не адресует/);
});

test('short domain acronyms ground a direct answer while question words stay irrelevant', () => {
  const sources = new Map([['request-1', 'Ставка НДС 20%, округление половины вверх до копейки.\nФорма счёта содержит номер и покупателя.']]);
  const question = 'Как именно будет вычисляться НДС в vat.ts?';
  equal(verifyQuestionCitation(question, 'request-1', [1, 1], sources), 'Ставка НДС 20%, округление половины вверх до копейки.');
  throws(() => verifyQuestionCitation(question, 'request-1', [2, 2], sources), /не адресует/);
});

test('evidence IDs are stable, bounded to twelve lines and resolve only within the current catalog', () => {
  const shown = Array.from({ length: 15 }, (_, index) => `rule ${index + 1} has enough detail`).join('\n');
  const first = buildQuestionEvidenceCatalog({ 'request-1': shown });
  const second = buildQuestionEvidenceCatalog({ 'request-1': shown });
  equal(first[4]!.id, second[4]!.id);
  equal(first[4]!.excerpt, shown.split('\n').slice(4, 16).join('\n'));
  equal(first[4]!.lines[1] - first[4]!.lines[0] + 1, 11);
  equal(first[0]!.lines[1] - first[0]!.lines[0] + 1, 12);
  const resolved = resolveQuestionEvidence('What does rule 5 require?', first[4]!.id, first);
  equal(resolved.reference.source, 'request-1');
  equal(resolved.reference.excerpt, shown);
  equal(resolved.quote, first[4]!.excerpt);
  throws(() => resolveQuestionEvidence('What does rule 5 require?', first[4]!.id, buildQuestionEvidenceCatalog({ 'request-1': `${shown}\nchanged` })), /Неизвестный evidenceId/);
  throws(() => resolveQuestionEvidence('What does rule 5 require?', 'handmade-source-lines', first), /Неизвестный evidenceId/);
});
