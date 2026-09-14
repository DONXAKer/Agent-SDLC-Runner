/**
 * Проверка коллектора (шаг 3 ROADMAP.md) — герметично, без модели и без сети.
 *
 * Доказывает две вещи: события реально доходят до диска через настоящий `appendEvent`
 * (`readPersistedEvents` их читает обратно), и состояние коллектора берёт из ленты только
 * то, чего нет в `run.metrics` — имена инструментов, размеры промптов, тексты вопросов.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deepStrictEqual, strictEqual } from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { NormalizedCall, RunEvent } from '@sdlc-runner/shared';

import { readPersistedEvents } from '../../server/src/eventLog.ts';
import { createCollector } from '../src/collector.ts';
import type { ToolRequestEvent, ToolResolvedEvent } from '../src/collector.ts';

function toolRequest(over: Partial<Extract<RunEvent, { type: 'tool_request' }>> & { call: NormalizedCall }): RunEvent {
  return {
    type: 'tool_request',
    runId: 'r1',
    stage: 'chunk',
    requestId: 'req-1',
    toolName: 'Write',
    rawInput: {},
    policy: { ok: true },
    preview: null,
    writeTargets: null,
    destructive: null,
    createdAt: Date.now(),
    ...over,
  };
}

describe('createCollector', () => {
  it('дописывает события на диск через appendEvent и читает их обратно', () => {
    const root = mkdtempSync(join(tmpdir(), 'sdlc-bench-collector-'));
    try {
      const slug = 'bench-x';
      const collector = createCollector({ projectRoot: () => root, slug: () => slug });

      const e: RunEvent = { type: 'run_started', runId: 'r1', slug, profile: 'control', projectRoot: root };
      collector.emit(e);

      const persisted = readPersistedEvents(root, slug);
      deepStrictEqual(persisted, [e]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('собирает имена инструментов и вид вызова из tool_request', () => {
    const root = mkdtempSync(join(tmpdir(), 'sdlc-bench-collector-'));
    try {
      const collector = createCollector({ projectRoot: () => root, slug: () => 's' });
      collector.emit(toolRequest({ toolName: 'Write', call: { kind: 'write', path: 'src/x.ts', content: 'x' } }));
      collector.emit(toolRequest({ toolName: 'Bash', call: { kind: 'bash', command: 'npm test' } }));

      strictEqual(collector.state.toolCalls.length, 2);
      deepStrictEqual(collector.state.toolCalls[0], { stage: 'chunk', toolName: 'Write', kind: 'write' });
      deepStrictEqual(collector.state.toolCalls[1], { stage: 'chunk', toolName: 'Bash', kind: 'bash' });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('собирает тексты вопросов из ask_human', () => {
    const root = mkdtempSync(join(tmpdir(), 'sdlc-bench-collector-'));
    try {
      const collector = createCollector({ projectRoot: () => root, slug: () => 's' });
      collector.emit(
        toolRequest({
          toolName: 'AskHuman',
          stage: 'ask',
          requestId: 'ask-1',
          call: {
            kind: 'ask_human',
            questions: [{ id: 'q1', question: 'Какая ставка?', header: 'H', multiSelect: false, options: [] }],
          },
        }),
      );

      strictEqual(collector.state.questions.length, 1);
      deepStrictEqual(collector.state.questions[0], {
        stage: 'ask',
        requestId: 'ask-1',
        questionId: 'q1',
        text: 'Какая ставка?',
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('собирает размеры промпта из prompt_prepared', () => {
    const root = mkdtempSync(join(tmpdir(), 'sdlc-bench-collector-'));
    try {
      const collector = createCollector({ projectRoot: () => root, slug: () => 's' });
      const e: RunEvent = {
        type: 'prompt_prepared',
        runId: 'r1',
        stage: 'plan',
        prompt: {
          presetNote: null,
          system: 'abc',
          user: 'defgh',
          tools: [],
          editedByOperator: true,
        },
      };
      collector.emit(e);

      strictEqual(collector.state.promptSizes.length, 1);
      deepStrictEqual(collector.state.promptSizes[0], {
        stage: 'plan',
        systemChars: 3,
        userChars: 5,
        editedByOperator: true,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('собирает отказы с тем, чем отказано: политика и нота перезаписи; разрешённый вызов — не отказ', () => {
    const root = mkdtempSync(join(tmpdir(), 'sdlc-bench-collector-'));
    try {
      const collector = createCollector({ projectRoot: () => root, slug: () => 's' });
      const note = 'перезапись .sdlc/s/exploration-report.md стирает поле решения человека: «Решение человека о полноте»';
      collector.emit(
        toolRequest({
          stage: 'explore',
          requestId: 'a',
          call: { kind: 'write', path: '.sdlc/s/exploration-report.md', content: 'x' },
          destructive: note,
        }),
      );
      collector.emit({
        type: 'tool_resolved',
        runId: 'r1',
        stage: 'explore',
        requestId: 'a',
        decision: { allowed: false, reason: `разрушающая перезапись: ${note}`, by: 'operator' },
      });
      collector.emit(
        toolRequest({
          stage: 'plan',
          requestId: 'b',
          call: { kind: 'write', path: 'src/x.ts', content: 'x' },
          policy: { ok: false, policy: 'planScope', reason: 'одобренного плана ещё нет' },
        }),
      );
      collector.emit({
        type: 'tool_resolved',
        runId: 'r1',
        stage: 'plan',
        requestId: 'b',
        decision: { allowed: false, reason: '[planScope] одобренного плана ещё нет', by: 'policy' },
      });
      collector.emit(toolRequest({ requestId: 'c', call: { kind: 'write', path: 'src/y.ts', content: 'y' } }));
      collector.emit({
        type: 'tool_resolved',
        runId: 'r1',
        stage: 'chunk',
        requestId: 'c',
        decision: { allowed: true, updatedInput: null, by: 'auto' },
      });

      deepStrictEqual(
        collector.state.denials?.map((d) => [d.requestId, d.stage, d.policy, d.destructive]),
        [
          ['a', 'explore', null, note],
          ['b', 'plan', 'planScope', null],
        ],
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('отмена ожидающего запроса (cancelRun) — не отказ; revalidate помечен автором решения', () => {
    const root = mkdtempSync(join(tmpdir(), 'sdlc-bench-collector-'));
    try {
      const collector = createCollector({ projectRoot: () => root, slug: () => 's' });
      collector.emit(toolRequest({ requestId: 'cancel', call: { kind: 'write', path: 'src/x.ts', content: 'x' } }));
      const cancelled: ToolResolvedEvent = {
        type: 'tool_resolved',
        runId: 'r1',
        stage: 'chunk',
        requestId: 'cancel',
        decision: { allowed: false, reason: 'прогон отменён', by: 'operator' },
        cancelled: true,
      };
      collector.emit(cancelled);

      collector.emit(toolRequest({ requestId: 'edit', call: { kind: 'write', path: 'src/y.ts', content: 'y' } }));
      collector.emit({
        type: 'tool_resolved',
        runId: 'r1',
        stage: 'chunk',
        requestId: 'edit',
        decision: { allowed: false, reason: 'правленые оператором аргументы не прошли политику [planScope]: x', by: 'policy' },
      });

      deepStrictEqual(
        collector.state.denials?.map((d) => [d.requestId, d.policy, d.by]),
        [['edit', null, 'policy']],
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('decisionsLost переносится в отказ; починка рантаймом собирается отдельно и отказом не считается', () => {
    const root = mkdtempSync(join(tmpdir(), 'sdlc-bench-collector-'));
    try {
      const collector = createCollector({ projectRoot: () => root, slug: () => 's' });
      const erased: ToolRequestEvent = {
        ...(toolRequest({ stage: 'explore', requestId: 'lost', call: { kind: 'write', path: '.sdlc/s/e.md', content: 'x' } }) as ToolRequestEvent),
        destructive: 'перезапись .sdlc/s/e.md: −40 строк',
        decisionsLost: ['Решение человека о полноте'],
      };
      collector.emit(erased);
      collector.emit({
        type: 'tool_resolved',
        runId: 'r1',
        stage: 'explore',
        requestId: 'lost',
        decision: { allowed: false, reason: 'разрушающая перезапись', by: 'operator' },
      });

      const repaired: ToolRequestEvent = {
        ...(toolRequest({ stage: 'plan', requestId: 'fix', call: { kind: 'write', path: '.sdlc/s/plan.md', content: 'x' } }) as ToolRequestEvent),
        repaired: 'рантайм вернул стёртое поле решения человека: «Одобрение»',
        decisionsLost: ['Одобрение'],
      };
      collector.emit(repaired);
      collector.emit({
        type: 'tool_resolved',
        runId: 'r1',
        stage: 'plan',
        requestId: 'fix',
        decision: { allowed: true, updatedInput: { content: 'y' }, by: 'auto' },
      });

      // Починённый, но отклонённый за другое вызов: не починка (не применился) и не «стирание
      // поля» (поле в нём возвращено).
      collector.emit({ ...repaired, requestId: 'fix-denied', destructive: 'перезапись: −300 строк' });
      collector.emit({
        type: 'tool_resolved',
        runId: 'r1',
        stage: 'plan',
        requestId: 'fix-denied',
        decision: { allowed: false, reason: 'разрушающая перезапись', by: 'operator' },
      });
      // Починённый и снятый обрывом — тоже не починка.
      collector.emit({ ...repaired, requestId: 'fix-cancelled' });
      collector.emit({
        type: 'tool_resolved',
        runId: 'r1',
        stage: 'plan',
        requestId: 'fix-cancelled',
        decision: { allowed: false, reason: 'прогон отменён', by: 'operator' },
        cancelled: true,
      });

      deepStrictEqual(
        collector.state.denials?.map((d) => [d.requestId, d.decisionsLost]),
        [['lost', ['Решение человека о полноте']], ['fix-denied', undefined]],
      );
      deepStrictEqual(collector.state.repairs, [{ stage: 'plan', requestId: 'fix', decisionsLost: ['Одобрение'] }]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('зовёт onEvent, кроме appendEvent — вторая точка подписки, не второй формат ленты', () => {
    const root = mkdtempSync(join(tmpdir(), 'sdlc-bench-collector-'));
    try {
      const seen: RunEvent[] = [];
      const collector = createCollector({ projectRoot: () => root, slug: () => 's', onEvent: (e) => seen.push(e) });
      const e: RunEvent = { type: 'run_started', runId: 'r1', slug: 's', profile: 'control', projectRoot: root };
      collector.emit(e);
      deepStrictEqual(seen, [e]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
