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
