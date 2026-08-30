import { deepStrictEqual, ok } from 'node:assert/strict';
import { describe, it } from 'node:test';

import { AskGate } from '../src/approval/askGate.ts';

// Живой виток ta-13: оператор ответил «нужны правки» и написал какие в note — модель
// получила голый label и переспросила. Примечание обязано доехать внутри answers.
describe('примечание оператора в ответе на вопрос', () => {
  it('note доезжает до модели отдельной записью ответов', async () => {
    const gate = new AskGate({ onPending: () => {}, onAnswered: () => {} });
    const p = gate.ask({ runId: 'r1', stage: 'plan', questions: [] });
    const requestId = gate.list()[0]!.requestId;
    ok(gate.answer('r1', requestId, { q1: ['нужны правки'] }, 'добавь тест на claim-4'));
    deepStrictEqual(await p, {
      q1: ['нужны правки'],
      'примечание оператора': ['добавь тест на claim-4'],
    });
  });

  it('пустое/отсутствующее note ответы не раздувает', async () => {
    const gate = new AskGate({ onPending: () => {}, onAnswered: () => {} });
    const p = gate.ask({ runId: 'r1', stage: 'plan', questions: [] });
    const requestId = gate.list()[0]!.requestId;
    ok(gate.answer('r1', requestId, { q1: ['одобряю'] }, '  '));
    deepStrictEqual(await p, { q1: ['одобряю'] });
  });
});
