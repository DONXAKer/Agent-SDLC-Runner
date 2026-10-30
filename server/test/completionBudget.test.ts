import test from 'node:test';
import assert from 'node:assert/strict';
import { COMPLETION_CEILING, completionLadder, reasoningShare, runawayRepetition } from '../src/exec/completionBudget.ts';

const climb = (ladder: ReturnType<typeof completionLadder>): number[] => {
  const steps = [ladder.start];
  for (let raises = 0; ; raises++) {
    const next = ladder.next(steps.at(-1)!, raises);
    if (next === null) return steps;
    steps.push(next);
  }
};

test('light profile keeps the former two-step ladder 4096 → 8192 → 16384', () => {
  assert.deepEqual(climb(completionLadder({ contextWindow: 32768, promptTokens: 0, reserve: 0 })), [4096, 8192, 16384]);
  assert.deepEqual(climb(completionLadder({ contextWindow: 32768, promptTokens: 0, reserve: 0, requested: 8192 })), [8192, 16384]);
});

test('heavy profile starts at the ceiling and never climbs', () => {
  const ladder = completionLadder({ contextWindow: 32768, promptTokens: 0, reserve: 0, reasoning: 'heavy' });
  assert.equal(ladder.start, COMPLETION_CEILING);
  assert.deepEqual(climb(ladder), [COMPLETION_CEILING]);
  // Явная планка ниже потолка остаётся планкой и для heavy.
  assert.deepEqual(climb(completionLadder({ contextWindow: 32768, promptTokens: 0, reserve: 0, reasoning: 'heavy', ceiling: 6000 })), [6000]);
});

test('none profile allows a single raise for genuinely long content', () => {
  assert.deepEqual(climb(completionLadder({ contextWindow: 32768, promptTokens: 0, reserve: 0, reasoning: 'none' })), [4096, 8192]);
});

test('the window remainder caps every step and the floor survives an overfull prompt', () => {
  assert.deepEqual(climb(completionLadder({ contextWindow: 16384, promptTokens: 10000, reasoning: 'heavy' })), [16384 - 10000 - 1024]);
  assert.deepEqual(climb(completionLadder({ contextWindow: 16384, promptTokens: 10000 })), [4096, 16384 - 10000 - 1024]);
  const floor = completionLadder({ contextWindow: 4096, promptTokens: 5000 });
  assert.equal(floor.start, 256);
  assert.equal(floor.next(256, 0), null);
});

test('reasoning share distinguishes a missing reasoning channel from zero', () => {
  assert.equal(reasoningShare({ outputTokens: 4096 }), null);
  assert.equal(reasoningShare({ outputTokens: 4096, reasoningTokens: 4096 }), 1);
  assert.equal(reasoningShare({ outputTokens: 1000, reasoningTokens: 250 }), 0.25);
  assert.equal(reasoningShare({ outputTokens: 0, reasoningTokens: 10 }), null);
});

test('runawayRepetition catches a truncated loop without flagging ordinary long text', () => {
  const block = '{"kind":"type_alias_declaration","name":"Customer","type":{"kind":"type","text":"import(\'./customer.ts\').Customer"}},';
  assert.equal(runawayRepetition(block.repeat(8)), true);
  // Период ≈226 — как в обрезанном typed IR пилота qwen27b (шаг ≠ 16; был пропуск 224→240).
  const ir = '            {\n              "kind": "type_alias_declaration",\n              "name": "Customer",\n              "type": {\n                "kind": "type",\n                "text": "import(\'./customer.ts\').Customer"\n              }\n            },\n';
  assert.ok(ir.length > 200 && ir.length < 280, `expected ~226-char IR block, got ${ir.length}`);
  assert.equal(runawayRepetition(ir.repeat(6)), true);
  assert.equal(runawayRepetition('short'), false);
  // Прогрессивный текст: суффикс уникален, петли нет.
  assert.equal(runawayRepetition(Array.from({ length: 200 }, (_, i) => `line-${i}-distinct-padding-xxxxxxxx`).join('\n')), false);
});
