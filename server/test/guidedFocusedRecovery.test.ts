import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { narrowGuidedRepair } from '../src/exec/guidedRecovery.ts';
import { guidedFieldInput, guidedGroupRequirements, packGuidedFieldQuestion } from '../src/exec/guidedContext.ts';
import { estimateMessageTokens } from '../src/exec/contextBudget.ts';

test('narrow recovery protects valid neighbours while repairing an invalid field', () => {
  const schema = z.object({ fact: z.string(), risks: z.array(z.string()) }).strict();
  const raw = { fact: 'already grounded in source', risks: 'none' };
  const result = schema.safeParse(raw); assert.equal(result.success, false);
  const repair = narrowGuidedRepair(raw, result.error, { json_schema: { name: 'research', schema: z.toJSONSchema(schema) } });
  assert.ok(repair);
  assert.deepEqual(schema.parse(repair.merge({ risks: [] })), { fact: raw.fact, risks: [] });
  assert.throws(() => repair.merge({ fact: 'replacement', risks: [] }));
  assert.equal(narrowGuidedRepair('not JSON', result.error, {}), null);
});

test('field context replaces only the current document snapshot and preserves operator input', () => {
  const input = { data: { requests: ['Exact original\nrequest'], operatorInstructions: { user: 'preserve API' },
    artifacts: [{ path: 'a/intent.md', sections: ['old'] }, { path: 'a/plan.md', sections: ['plan'] }] } };
  assert.deepEqual(guidedFieldInput(input, ['a\\intent.md']), { data: { ...input.data, artifacts: [input.data.artifacts[1]] } });
  assert.equal(input.data.artifacts.length, 2);
  const focused = guidedGroupRequirements(JSON.stringify({ acceptance: [{ id: 'a' }, { id: 'b' }], constraints: ['do not change API'] }), ['a']) as Record<string, unknown>;
  assert.deepEqual(focused.acceptance, [{ id: 'a' }]);
  assert.deepEqual(focused.constraints, ['do not change API']);
  assert.deepEqual(focused.otherRequirementIds, ['b']);
});

test('guided field pack shrinks handoff artifacts until the question fits a 16k window', () => {
  const bulky = 'claim text and evidence '.repeat(800);
  const data = {
    input: {
      version: 1,
      questionId: 'handoff:input',
      question: 'stage',
      data: {
        requests: ['Добавь validateCustomer'],
        artifacts: [
          { path: '.sdlc/x/intent.md', sections: [{ section: 'Цель', values: [bulky] }] },
          { path: '.sdlc/x/plan.md', sections: [{ section: 'Шаги', values: [bulky] }] },
          { path: '.sdlc/x/verification-report-1-attempt-1.md', sections: [{ section: 'Вердикт', values: [bulky] }] },
          { path: '.sdlc/x/chunk-1-journal.md', sections: [{ section: 'Ход', values: [bulky] }] },
          { path: '.sdlc/gates.md', sections: [{ section: 'Гейты', values: [bulky] }] },
        ],
      },
    },
    currentFacts: [{ section: 'Виток', values: [bulky] }],
    topic: 'что сделано',
    feedback: '',
  };
  const system = 'Ответь JSON.';
  const packed = packGuidedFieldQuestion(system, 'что сделано', 'Какое значение: что сделано?', data, 16384);
  assert.ok(packed.truncated);
  assert.ok(packed.available >= 512);
  assert.equal(packed.data.truncatedForContext, true);
  const tokens = estimateMessageTokens([{ content: system }, { content: packed.question }]);
  assert.ok(tokens + 1024 + 512 <= 16384, `still too large: ${tokens}`);
  // Окно меньше запаса ответа (512) + margin (1024) — ужать некуда.
  assert.throws(() => packGuidedFieldQuestion(system, 'что сделано', 'Какое значение: что сделано?', {
    input: { data: { requests: ['req'], artifacts: [{ path: 'intent.md', sections: [{ section: 'a', values: ['ok'] }] }] } },
  }, 512), /не помещается в контекст/);
});
