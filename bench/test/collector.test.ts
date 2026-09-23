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

  it('отказ политики по AskHuman — отказ, а не пропажа: гейт шлёт по нему tool_resolved', () => {
    const root = mkdtempSync(join(tmpdir(), 'sdlc-bench-collector-'));
    try {
      const collector = createCollector({ projectRoot: () => root, slug: () => 's' });
      collector.emit(
        toolRequest({
          toolName: 'AskHuman',
          requestId: 'ask-denied',
          call: {
            kind: 'ask_human',
            questions: [{ id: 'q1', question: 'Можно?', header: 'H', multiSelect: false, options: [] }],
          },
          policy: { ok: false, policy: 'stageTools', reason: 'AskHuman не выдан этапу' },
        }),
      );
      collector.emit({
        type: 'tool_resolved',
        runId: 'r1',
        stage: 'chunk',
        requestId: 'ask-denied',
        decision: { allowed: false, reason: '[stageTools] AskHuman не выдан этапу', by: 'policy' },
      });
      deepStrictEqual(
        collector.state.denials?.map((d) => [d.requestId, d.kind, d.policy]),
        [['ask-denied', 'ask_human', 'stageTools']],
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
      deepStrictEqual(collector.state.repairs, [{ stage: 'plan', requestId: 'fix', kind: 'decision', decisionsLost: ['Одобрение'] }]);
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

/**
 * Свой артефакт не по своему пути (test27/test29, 2026-09-22…23): голое имя и опечатка в
 * слаге — ошибка адресации, не граница. Коллектор помечает такой отказ структурно, а
 * перенаправленный гейтом вызов (`readdressed`) считает починкой своего класса.
 */
describe('createCollector: адрес своего артефакта', () => {
  it('отказ по артефакту витка мимо каталога витка помечен ownArtifactMisaddressed; в своём каталоге и чужое имя — нет', () => {
    const root = mkdtempSync(join(tmpdir(), 'sdlc-collector-'));
    try {
      const collector = createCollector({ projectRoot: () => root, slug: () => 'freeship' });
      const deny = (requestId: string, path: string) => {
        collector.emit(
          toolRequest({ stage: 'ask', requestId, call: { kind: 'write', path, content: 'x' }, policy: { ok: false, policy: 'planScope', reason: 'вне плана' } }),
        );
        collector.emit({ type: 'tool_resolved', runId: 'r1', stage: 'ask', requestId, decision: { allowed: false, reason: '[planScope] вне плана', by: 'policy' } });
      };
      deny('bare', 'clarification-report.md');
      deny('typo', '.sdlc/freesship/clarification-report.md');
      deny('own', '.sdlc/freeship/intent.md');
      deny('alien', 'notes.md');
      // Выход за проект и то же имя в продуктовом каталоге — граница, не адресация.
      deny('outside', '../../plan.md');
      deny('product', 'docs/plan.md');
      deepStrictEqual(
        collector.state.denials?.map((d) => [d.requestId, d.ownArtifactMisaddressed]),
        [['bare', true], ['typo', true], ['own', undefined], ['alien', undefined], ['outside', undefined], ['product', undefined]],
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('перенаправленный гейтом вызов — починка класса «address», не «decision»', () => {
    const root = mkdtempSync(join(tmpdir(), 'sdlc-collector-'));
    try {
      const collector = createCollector({ projectRoot: () => root, slug: () => 'freeship' });
      collector.emit({
        ...(toolRequest({ stage: 'ask', requestId: 'moved', call: { kind: 'write', path: `${root}/.sdlc/freeship/clarification-report.md`, content: 'x' } }) as ToolRequestEvent),
        readdressed: 'рантайм перенаправил запись «clarification-report.md» в артефакт этапа «clarification»',
      });
      collector.emit({ type: 'tool_resolved', runId: 'r1', stage: 'ask', requestId: 'moved', decision: { allowed: true, updatedInput: { file_path: 'x' }, by: 'auto' } });
      deepStrictEqual(collector.state.repairs, [{ stage: 'ask', requestId: 'moved', kind: 'address' }]);
      deepStrictEqual(collector.state.denials, []);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('вызов с двумя починками (поле решения и адрес) считается обеими', () => {
    const root = mkdtempSync(join(tmpdir(), 'sdlc-collector-'));
    try {
      const collector = createCollector({ projectRoot: () => root, slug: () => 'freeship' });
      collector.emit({
        ...(toolRequest({ stage: 'plan', requestId: 'both', call: { kind: 'write', path: `${root}/.sdlc/freeship/plan.md`, content: 'x' } }) as ToolRequestEvent),
        repaired: 'возвращено поле «Одобрение»',
        decisionsLost: ['Одобрение'],
        readdressed: 'рантайм перенаправил запись «plan.md» в артефакт этапа «plan»',
      });
      collector.emit({ type: 'tool_resolved', runId: 'r1', stage: 'plan', requestId: 'both', decision: { allowed: true, updatedInput: { file_path: 'x' }, by: 'auto' } });
      deepStrictEqual(
        collector.state.repairs?.map((r) => r.kind),
        ['decision', 'address'],
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('перенаправленный, но отклонённый вызов помечен ownArtifactMisaddressed', () => {
    const root = mkdtempSync(join(tmpdir(), 'sdlc-collector-'));
    try {
      const collector = createCollector({ projectRoot: () => root, slug: () => 'freeship' });
      collector.emit({
        ...(toolRequest({ stage: 'ask', requestId: 'moved-denied', call: { kind: 'write', path: `${root}/.sdlc/freeship/clarification-report.md`, content: 'x' } }) as ToolRequestEvent),
        readdressed: 'рантайм перенаправил запись',
      });
      collector.emit({ type: 'tool_resolved', runId: 'r1', stage: 'ask', requestId: 'moved-denied', decision: { allowed: false, reason: 'отказ оператора', by: 'operator' } });
      strictEqual(collector.state.denials?.[0]?.ownArtifactMisaddressed, true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
