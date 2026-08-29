/**
 * Коллектор наблюдений (часть шага 3 ROADMAP.md).
 *
 * Кормит настоящий `appendEvent` — своего формата ленты бенчмарк не заводит, и это не
 * стилевой выбор: `run.metrics` уже считает токены, стоимость, время, попытки и трение —
 * дублировать их разбором ленты значило бы завести второе место, которое может разойтись
 * с первым (см. предупреждение того же рода в `operator.ts` про `destructive`/`writeTargets`).
 * Отсюда берётся только то, чего в `RunMetrics` нет вовсе: имена вызванных инструментов,
 * размеры промптов и тексты заданных вопросов — три вещи, о которых числа ничего не говорят.
 */

import type { EventSink, RunEvent, StageId } from '@sdlc-runner/shared';

import { appendEvent } from '../../server/src/eventLog.ts';

export interface CollectedToolCall {
  stage: StageId;
  toolName: string;
  kind: string;
}

export interface CollectedPromptSize {
  stage: StageId;
  systemChars: number;
  userChars: number;
  editedByOperator: boolean;
}

export interface CollectedQuestion {
  stage: StageId;
  requestId: string;
  questionId: string;
  text: string;
}

export interface CollectorState {
  toolCalls: CollectedToolCall[];
  promptSizes: CollectedPromptSize[];
  questions: CollectedQuestion[];
}

export function emptyCollectorState(): CollectorState {
  return { toolCalls: [], promptSizes: [], questions: [] };
}

export interface Collector {
  /** Передаётся в `new Run({ emit })` — единственный способ узнать о вызове изнутри витка. */
  emit: EventSink;
  state: CollectorState;
}

/**
 * `projectRoot`/`slug` — функции, а не значения: рабочая копия у бенчмарка одна на прогон,
 * но собирается уже ПОСЛЕ вызова `createCollector` (см. `driver.ts`), и коллектор обязан
 * увидеть готовый путь, а не тот, что был на момент своего создания.
 */
export function createCollector(args: {
  projectRoot: () => string;
  slug: () => string;
  onEvent?: (e: RunEvent) => void;
}): Collector {
  const state = emptyCollectorState();

  const emit: EventSink = (e) => {
    appendEvent(args.projectRoot(), args.slug(), e);
    args.onEvent?.(e);

    if (e.type === 'tool_request') {
      state.toolCalls.push({ stage: e.stage, toolName: e.toolName, kind: e.call.kind });
      if (e.call.kind === 'ask_human') {
        for (const q of e.call.questions) {
          state.questions.push({ stage: e.stage, requestId: e.requestId, questionId: q.id, text: q.question });
        }
      }
      return;
    }

    if (e.type === 'prompt_prepared') {
      state.promptSizes.push({
        stage: e.stage,
        systemChars: e.prompt.system.length,
        userChars: e.prompt.user.length,
        editedByOperator: e.prompt.editedByOperator,
      });
    }
  };

  return { emit, state };
}
