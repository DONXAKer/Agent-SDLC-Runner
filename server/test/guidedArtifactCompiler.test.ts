import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalGuidedJson, compileIntent, compileQuestions } from '../src/artifacts/guidedArtifactCompiler.ts';
import { unreflectedAnswers } from '../src/artifacts/humanFacts.ts';

const request = 'Add the total operation.\nReturn the calculated total.';
const intent = {
  version: 1,
  acceptance: [{ id: 'claim-1', behavior: 'The total is calculated', procedure: 'Call the operation', expected: 'The calculated total is returned' }],
  basis: [{ id: 'claim-1', basis: { source: 'request-1', lines: [1, 2] }, scenario: 'A total is requested', counterexample: 'No total is returned' }],
};

test('intent compilation is canonical and materializes exact request evidence', () => {
  const first = compileIntent(intent, { 'request-1': request });
  const reordered = {
    basis: intent.basis.map(row => ({ counterexample: row.counterexample, scenario: row.scenario,
      basis: { lines: row.basis.lines, source: row.basis.source }, id: row.id })),
    acceptance: intent.acceptance.map(row => ({ expected: row.expected, procedure: row.procedure, behavior: row.behavior, id: row.id })),
    version: 1,
  };
  const second = compileIntent(reordered, { 'request-1': request });
  assert.equal(first.canonical, second.canonical);
  assert.equal(first.acceptanceJson, second.acceptanceJson);
  assert.equal(first.basisJson, second.basisJson);
  assert.match(first.requirements.basis[0]!.basis, /request-1:L1-L2 «Add the total operation\. Return the calculated total\.»/u);
  assert.equal(canonicalGuidedJson({ z: 1, a: { z: 2, a: 3 } }), '{\n  "a": {\n    "a": 3,\n    "z": 2\n  },\n  "z": 1\n}\n');
});

test('intent compiler rejects unknown evidence and uncovered claims', () => {
  assert.throws(() => compileIntent({ ...intent, basis: [{ ...intent.basis[0]!, basis: { source: 'missing', lines: [1, 1] } }] }, { 'request-1': request }), /Неизвестный источник/u);
  assert.throws(() => compileIntent({ ...intent, basis: [] }, { 'request-1': request }), /Нет оснований/u);
  assert.throws(() => compileIntent({ ...intent, acceptance: [intent.acceptance[0]!, intent.acceptance[0]!] }, { 'request-1': request }), /Дубль требования/u);
});

test('question compilation replays the exact validated excerpt without regenerating text', () => {
  const value = {
    version: 1,
    entries: [{
      id: 'question-1', question: 'Where is the total defined?', origin: ['explore'], requestHash: 'request-hash',
      status: 'source', answer: 'It is defined in the supplied module.', reason: 'Source answer', options: [],
      sourceHashes: { 'src/total.ts': 'source-hash' }, citations: [],
      evidence: [{ source: 'src/total.ts', lines: [1, 2], excerpt: 'export const total = 1;\n// Keep the export.' }],
    }],
  };
  const sources = { 'src/total.ts': '// Header\nexport const total = 1;\n// Keep the export.' };
  const input = { slug: 'neutral-example', humanFacts: [] };
  const first = compileQuestions(value, sources, input);
  const second = compileQuestions(value, sources, input);
  assert.equal(first.markdown, second.markdown);
  assert.equal(first.canonical, second.canonical);
  assert.deepEqual(first.entries[0]!.citations, [{ source: 'src/total.ts', quote: 'export const total = 1;\n// Keep the export.' }]);
  assert.match(first.markdown, /export const total = 1;/u);
  assert.throws(() => compileQuestions(value, { 'src/total.ts': 'different source' }, input), /Выдержка не принадлежит источнику/u);
});

test('an unresolved business decision stays unresolved', () => {
  const result = compileQuestions({ version: 1, entries: [{
    id: 'question-2', question: 'Which public rate applies?', origin: ['intent'], requestHash: 'hash', status: 'human',
    answer: '', reason: 'The source does not define the rate', options: ['A', 'B'], sourceHashes: {}, citations: [],
  }] }, {}, { slug: 'neutral-example', humanFacts: [] });
  assert.equal(result.entries[0]!.status, 'human');
  assert.equal(result.entries[0]!.answer, '');
  assert.match(result.markdown, /Which public rate applies\? — human/u);
});

test('human fact fallback describes the literal answer instead of journal status', () => {
  const result = compileQuestions({ version: 1, entries: [] }, {}, {
    slug: 'neutral-example',
    humanFacts: [{ question: 'Which limit applies?', answer: '5000', changed: '' }],
  });
  assert.match(result.markdown, /\| Which limit applies\? \| да \| 5000 \| 5000 \|/u);
  assert.doesNotMatch(result.markdown, /Дословный ответ человека/u);
  assert.deepEqual(unreflectedAnswers(result.markdown), []);
});

test('question compilation preserves trailing blank lines inside a cited source range', () => {
  const excerpt = 'The required value is two.\n';
  const result = compileQuestions({ version: 1, entries: [{
    id: 'question-3', question: 'Which value is required?', origin: ['explore'], requestHash: 'hash', status: 'source',
    answer: 'Two', reason: 'Source answer', options: [], sourceHashes: { 'request-1': 'hash' }, citations: [],
    evidence: [{ source: 'request-1', lines: [1, 2], excerpt }],
  }] }, { 'request-1': excerpt }, { slug: 'neutral-example', humanFacts: [] });
  assert.equal(result.entries[0]!.evidence?.[0]?.excerpt, excerpt);
  assert.deepEqual(result.entries[0]!.citations, [{ source: 'request-1', quote: 'The required value is two.' }]);
});
