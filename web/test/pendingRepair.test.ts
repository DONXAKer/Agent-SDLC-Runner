/**
 * Поля починки стёртого решения человека доходят до карточки одобрения.
 *
 * `mergePending` копирует поля поимённо, и `repaired` в нём не копировался ни из ответа
 * сервера, ни из ленты: сервер возвращал поле, а оператор не видел, что часть содержимого
 * вписал рантайм, а не модель.
 */

import { deepStrictEqual, strictEqual } from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { PendingApproval, RunDetail, RunEvent } from '@sdlc-runner/shared';

import { mergePending } from '../src/lib/pending.ts';

type ToolRequestEvent = Extract<RunEvent, { type: 'tool_request' }>;

const REPAIRED = 'рантайм вернул стёртое поле решения человека: «Решение человека о полноте»';
const LOST = ['Решение человека о полноте'];

function req(requestId: string, over: Partial<ToolRequestEvent> = {}): ToolRequestEvent {
  return {
    type: 'tool_request',
    runId: 'r',
    stage: 'explore',
    requestId,
    toolName: 'Write',
    rawInput: {},
    call: { kind: 'write', path: 'a.md', content: '' },
    policy: { ok: true },
    preview: null,
    writeTargets: null,
    destructive: null,
    createdAt: 0,
    ...over,
  };
}

describe('mergePending: поля починки', () => {
  it('из события tool_request', () => {
    const { approvals } = mergePending(null, [req('a', { repaired: REPAIRED, decisionsLost: LOST })]);
    strictEqual(approvals[0]?.repaired, REPAIRED);
    deepStrictEqual(approvals[0]?.decisionsLost, LOST);
  });

  it('из ответа сервера', () => {
    const p: PendingApproval = {
      runId: 'r',
      stage: 'explore',
      requestId: 'b',
      toolName: 'Write',
      rawInput: {},
      call: { kind: 'write', path: 'a.md', content: '' },
      policy: { ok: true },
      preview: null,
      writeTargets: null,
      destructive: null,
      repaired: REPAIRED,
      decisionsLost: LOST,
      createdAt: 0,
    };
    const { approvals } = mergePending({ pendingApprovals: [p], pendingQuestions: [] } as unknown as RunDetail, []);
    strictEqual(approvals[0]?.repaired, REPAIRED);
    deepStrictEqual(approvals[0]?.decisionsLost, LOST);
  });

  it('без починки полей нет вовсе, а не undefined-ключи', () => {
    const { approvals } = mergePending(null, [req('c')]);
    strictEqual('repaired' in approvals[0]!, false);
    strictEqual('decisionsLost' in approvals[0]!, false);
  });
});
