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

import type { EventSink, PolicyName, RunEvent, StageId } from '@sdlc-runner/shared';

import { appendEvent } from '../../server/src/eventLog.ts';

/**
 * Поля событий, которые рантайм может ещё не нести в типе: старые ленты и версии сервера
 * без них должны читаться, а не падать. Локальное расширение, а не правка контракта: контракт
 * событий — `shared`, и коллектор его не расширяет.
 */
export type ToolRequestEvent = Extract<RunEvent, { type: 'tool_request' }> & {
  /** Рантайм вернул в содержимое стёртое поле решения человека (`restoreErasedDecisions`). */
  repaired?: string;
  /** Метки полей решений человека, стёртых ИСХОДНЫМ вызовом. */
  decisionsLost?: string[];
};
export type ToolResolvedEvent = Extract<RunEvent, { type: 'tool_resolved' }> & {
  /** Запрос снят обрывом прогона (`cancelRun`), а не решён. */
  cancelled?: true;
};

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
  /**
   * Политика, отклонившая вызов на входе в гейт; `null` — вход политику прошёл. Тип —
   * контрактный `PolicyName`, а не строка: новая политика обязана всплыть в `classifyDenial`
   * ошибкой компиляции, а не молча упасть в «отказ оператора». Результаты, записанные до
   * появления политики, могут нести и неизвестное имя — отчёт это переживает.
   */
  policy: PolicyName | null;
  /** Нота гейта о перезаписи с потерей содержимого (`destructiveOverwrite`), если была. */
  destructive: string | null;
  /** Метки стёртых полей решений человека — из события; нет у результатов старше поля. */
  decisionsLost?: string[];
  /**
   * Кто вынес отказ (`Decision.by`). `policy` при прошедшем политику входе — это правка
   * аргументов оператором, не прошедшая повторную проверку (`ApprovalGate.revalidate`), а не
   * отказ оператора. Нет у результатов старше поля.
   */
  by?: 'policy' | 'operator';
  reason: string;
}

/**
 * Починка рантаймом: вызов стёр поле решения человека, рантайм вернул его в содержимое
 * (`restoreErasedDecisions`), и отказа не было. Без отдельного счёта ручка стирала класс
 * «стирание поля решения» из отчёта целиком — ошибка модели осталась, а видно её не было.
 */
export interface CollectedRepair {
  stage: StageId;
  requestId: string;
  decisionsLost?: string[];
}

export interface CollectorState {
  toolCalls: CollectedToolCall[];
  promptSizes: CollectedPromptSize[];
  questions: CollectedQuestion[];
  /** Необязательно только для чтения результатов, записанных до появления поля. */
  denials?: CollectedDenial[];
  /** Необязательно только для чтения результатов, записанных до появления поля. */
  repairs?: CollectedRepair[];
}

export function emptyCollectorState(): CollectorState {
  return { toolCalls: [], promptSizes: [], questions: [], denials: [], repairs: [] };
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
  const repairs: CollectedRepair[] = [];
  state.denials = denials;
  state.repairs = repairs;
  /** Запрос ждёт решения: отказ приходит отдельным `tool_resolved` без имени и политики. */
  const pending = new Map<string, Omit<CollectedDenial, 'reason' | 'by'>>();

  const emit: EventSink = (e) => {
    appendEvent(args.projectRoot(), args.slug(), e);
    args.onEvent?.(e);

    if (e.type === 'tool_resolved') {
      const resolved: ToolResolvedEvent = e;
      const req = pending.get(resolved.requestId);
      pending.delete(resolved.requestId);
      // Отмена ожидающего запроса (`cancelRun`) приходит решением `by: 'operator'`, но это
      // обрыв прогона, а не отказ: без фильтра каждый снятый таймаутом этап добавлял модели
      // «отказ оператора», которого не было.
      if (resolved.cancelled === true) return;
      if (req !== undefined && !resolved.decision.allowed) {
        denials.push({ ...req, by: resolved.decision.by, reason: resolved.decision.reason });
      }
      return;
    }

    if (e.type === 'tool_request') {
      const request: ToolRequestEvent = e;
      const lost = request.decisionsLost;
      pending.set(request.requestId, {
        stage: request.stage,
        requestId: request.requestId,
        toolName: request.toolName,
        kind: request.call.kind,
        policy: request.policy.ok ? null : request.policy.policy,
        destructive: request.destructive,
        ...(lost === undefined ? {} : { decisionsLost: [...lost] }),
      });
      if (request.repaired !== undefined) {
        repairs.push({
          stage: request.stage,
          requestId: request.requestId,
          ...(lost === undefined ? {} : { decisionsLost: [...lost] }),
        });
      }
      state.toolCalls.push({ stage: request.stage, toolName: request.toolName, kind: request.call.kind });
      if (request.call.kind === 'ask_human') {
        for (const q of request.call.questions) {
          state.questions.push({ stage: request.stage, requestId: request.requestId, questionId: q.id, text: q.question });
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
