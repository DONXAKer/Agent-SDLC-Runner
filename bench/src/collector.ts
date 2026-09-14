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

/**
 * Отклонённый вызов — с тем, ЧЕМ он отклонён. В `OperatorDecisionLog.notMine` оседал
 * только признак «политика», и отчёт склеивал в «отказ политики» пять несовместимых
 * диагнозов серии v4: стирание поля человека, битый путь, запись до одобрения плана,
 * необъявленный субагент и вызов без разобранных аргументов.
 */
export interface CollectedDenial {
  stage: StageId;
  requestId: string;
  toolName: string;
  kind: string;
  /** Политика, отклонившая вызов; `null` — отказал оператор, а не политика. */
  policy: string | null;
  /** Нота гейта о перезаписи с потерей содержимого (`destructiveOverwrite`), если была. */
  destructive: string | null;
  reason: string;
}

export interface CollectorState {
  toolCalls: CollectedToolCall[];
  promptSizes: CollectedPromptSize[];
  questions: CollectedQuestion[];
  /** Необязательно только для чтения результатов, записанных до появления поля. */
  denials?: CollectedDenial[];
}

export function emptyCollectorState(): CollectorState {
  return { toolCalls: [], promptSizes: [], questions: [], denials: [] };
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
  const denials: CollectedDenial[] = [];
  state.denials = denials;
  /** Запрос ждёт решения: отказ приходит отдельным `tool_resolved` без имени и политики. */
  const pending = new Map<string, Omit<CollectedDenial, 'reason'>>();

  const emit: EventSink = (e) => {
    appendEvent(args.projectRoot(), args.slug(), e);
    args.onEvent?.(e);

    if (e.type === 'tool_resolved') {
      const req = pending.get(e.requestId);
      pending.delete(e.requestId);
      if (req !== undefined && !e.decision.allowed) denials.push({ ...req, reason: e.decision.reason });
      return;
    }

    if (e.type === 'tool_request') {
      pending.set(e.requestId, {
        stage: e.stage,
        requestId: e.requestId,
        toolName: e.toolName,
        kind: e.call.kind,
        policy: e.policy.ok ? null : e.policy.policy,
        destructive: e.destructive,
      });
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
