import { test } from 'node:test';
import { deepStrictEqual, throws } from 'node:assert/strict';
import { z } from 'zod';
import { intentIssueBatchFormat, parseIntentIssueBatch } from '../src/exec/intentIssueAdjudication.ts';

test('batch adjudication retains issue identity, including compatible and unresolved allegations', () => {
  const judgment = { relation: 'compatible', condition: 'invalid input', explanation: 'rejecting invalid input is testable', witness: 'return an error', conflict: null };
  const obligations = [{ assertion: 1, lines: [1, 1], subject: 'result', condition: 'invalid input', requiredResult: 'allow' },
    { assertion: 2, lines: [1, 1], subject: 'result', condition: 'invalid input', requiredResult: 'reject' }];
  const judgments = [{ ...judgment, issue: 3, relation: 'unknown' }, { ...judgment, issue: 1 }, { ...judgment, issue: 2, relation: 'contradictory', conflict: obligations }];
  const assertions = [['allow input', 'reject input'], ['allow input', 'reject input'], ['allow input', 'reject input']];
  deepStrictEqual(parseIntentIssueBatch(JSON.stringify({ judgments }), 3, assertions).map(row => [row.issue, row.relation]),
    [[1, 'compatible'], [2, 'unknown'], [3, 'unknown']]);
  throws(() => parseIntentIssueBatch(JSON.stringify({ judgments: [judgments[0], judgments[0], judgments[1]] }), 3), /exactly once/);
  throws(() => parseIntentIssueBatch(JSON.stringify({ judgments: judgments.slice(1) }), 3));
  throws(() => parseIntentIssueBatch(JSON.stringify({ judgments: [{ ...judgment, issue: 4 }] }), 1));
  throws(() => intentIssueBatchFormat(0));
});

test('batch schema is supported by the stateless decision validator', () => {
  const validator = z.fromJSONSchema(intentIssueBatchFormat(2).json_schema.schema);
  const row = { relation: 'compatible', condition: 'input', explanation: 'both satisfied', witness: 'construction', conflict: null };
  validator.parse({ judgments: [{ ...row, issue: 1 }, { ...row, issue: 2 }] });
  throws(() => validator.parse({ judgments: [{ ...row, issue: 1 }] }));
});

test('contradiction evidence materializes exact Markdown from addressed lines', () => {
  const left = { assertion: 1, lines: [2, 2], subject: 'result', condition: 'input X', requiredResult: 'allow' };
  const right = { ...left, assertion: 2, lines: [1, 1], requiredResult: 'reject' };
  const judgment = { issue: 1, relation: 'contradictory', condition: 'input X', explanation: 'opposing obligations', witness: 'input X', conflict: [left, right] };
  const assertions = [['header\nmust **allow** `input`', 'must reject input']];
  const [parsed] = parseIntentIssueBatch(JSON.stringify({ judgments: [judgment] }), 1, assertions);
  deepStrictEqual([parsed?.relation, parsed?.conflict], ['unknown', null]);
  const parse = (conflict: unknown) => parseIntentIssueBatch(JSON.stringify({ judgments: [{ ...judgment, conflict }] }), 1, assertions);
  throws(() => parse(null), /two addressed obligations/);
  throws(() => parse([left, { ...right, subject: 'other field' }]), /Different subjects/);
  throws(() => parse([left, { ...right, condition: 'input Y' }]), /Different subjects/);
  throws(() => parse([left, { ...right, requiredResult: 'allow' }]), /distinct obligations/);
  deepStrictEqual(parse([left, { ...right, lines: [2, 2] }])[0]?.relation, 'unknown');
  deepStrictEqual(parse([{ ...left, assertion: 3 }, right])[0]?.relation, 'unknown');
  throws(() => parseIntentIssueBatch(JSON.stringify({ judgments: [judgment] }), 1), /Unknown issue evidence/);
  const reparsed = parseIntentIssueBatch(JSON.stringify({ judgments: [parsed] }), 1, assertions);
  deepStrictEqual(reparsed[0]?.relation, 'unknown');
  throws(() => z.fromJSONSchema(intentIssueBatchFormat(1).json_schema.schema).parse({ judgments: [{ ...judgment,
    conflict: [left, { ...right, excerpt: 'invented requirement' }] }] }));
});

test('source citations and model labels do not prove incompatible semantics', () => {
  for (const assertions of [['x >= 1', 'x <= 10'], ['email must contain a dot', 'phone must contain digits']]) {
    const proof = assertions.map((requiredResult, index) => ({ assertion: index + 1, lines: [1, 1], subject: 'object', condition: 'same input', requiredResult }));
    const judgment = { issue: 1, relation: 'contradictory', condition: 'same input', explanation: 'different results', witness: 'claimed conflict', conflict: proof };
    const [result] = parseIntentIssueBatch(JSON.stringify({ judgments: [judgment] }), 1, [assertions]);
    deepStrictEqual(result?.relation, 'unknown');
  }
});
