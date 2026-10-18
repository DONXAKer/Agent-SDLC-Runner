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

import { basename } from 'node:path';

import type { EventSink, NormalizedCall, PolicyName, RunEvent, StageId } from '@sdlc-runner/shared';

import { SDLC_DIR, isWitokArtifactName } from '../../server/src/artifacts/paths.ts';
import { isWindowsStyle, lexicalNormalize, pathsEqual, relativizeWithin, resolveUserPath } from '../../server/src/policy/paths.ts';

import { appendEvent } from '../../server/src/eventLog.ts';

export type ToolRequestEvent = Extract<RunEvent, { type: 'tool_request' }>;
export type ToolResolvedEvent = Extract<RunEvent, { type: 'tool_resolved' }>;

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
  /**
   * Цель записи — артефакт витка по имени (`isWitokArtifactName`), но не в каталоге
   * своего витка: голое `clarification-report.md`, опечатка в слаге. Ошибка адресации, а
   * не попытка выйти за границы — отчёт классифицирует её отдельно от «записи вне плана»
   * (test27/test29: метка «опасна» за опечатку в слаге). Нет у результатов старше поля.
   */
  ownArtifactMisaddressed?: true;
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
  /**
   * Что чинил рантайм: стёртое поле решения (`repaired`) или адрес своего артефакта
   * (`readdressed`, `approval/artifactAddress.ts`). Нет у результатов старше поля — там
   * починка одна, стёртое поле.
   */
  kind?: 'decision' | 'address';
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

/**
 * Запись артефакта витка по имени мимо каталога своего витка. По ИМЕНИ, а не по ключу
 * этапа: коллектор не знает, что этап производит, — знает только, как называются
 * артефакты витка вообще, и этого достаточно, чтобы отличить опечатку в слаге от `.bak`
 * в корне проекта.
 *
 * Адресацией считаются те же два вида, что перенаправляет гейт (`artifactAddress.ts`):
 * голое имя в корне проекта и путь под `.sdlc/`. Путь вне проекта и то же имя в
 * продуктовом каталоге (`docs/plan.md`) — пересечение границы, и уводить их из граничных
 * классов значило бы снимать метку «опасна» с настоящего выхода за проект или план
 * (code-review-all 2026-09-23).
 */
function misaddressedOwnArtifact(call: NormalizedCall, projectRoot: string, slug: string): boolean {
  if (call.kind !== 'write' && call.kind !== 'edit') return false;
  if (!isWitokArtifactName(basename(lexicalNormalize(call.path)))) return false;
  const rel = relativizeWithin(projectRoot, resolveUserPath(projectRoot, call.path));
  if (rel === null) return false;
  const ci = isWindowsStyle(projectRoot);
  if (rel.includes('/') && !pathsEqual(rel.split('/')[0] ?? '', SDLC_DIR, ci)) return false;
  const own = `${SDLC_DIR}/${slug}/`;
  return !pathsEqual(rel.slice(0, own.length), own, ci);
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
  /**
   * Запрос ждёт решения: отказ приходит отдельным `tool_resolved` без имени и политики.
   * Починка тоже ждёт исхода — отклонённый или снятый обрывом починенный вызов не применился,
   * и «починено рантаймом» о нём было бы неправдой.
   */
  const pending = new Map<string, { denial: Omit<CollectedDenial, 'reason' | 'by'>; repairKinds: ('decision' | 'address')[] }>();

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
      if (resolved.cancelled === true || req === undefined) return;
      if (resolved.decision.allowed) {
        // Обе починки одного вызова считаются обе: прежде при одновременных `repaired` и
        // `readdressed` в отчёт попадала только починка поля, адресная пропадала.
        for (const kind of req.repairKinds) {
          const lost = req.denial.decisionsLost;
          repairs.push({
            stage: req.denial.stage,
            requestId: req.denial.requestId,
            kind,
            ...(kind === 'decision' && lost !== undefined ? { decisionsLost: [...lost] } : {}),
          });
        }
        return;
      }
      // Отклонён починенный вызов: стёртое поле в нём уже возвращено, и отказ вынесен за
      // другое — метки потери увели бы его в класс «стирание поля решения».
      const { decisionsLost: _lost, ...rest } = req.denial;
      const denial = req.repairKinds.includes('decision') ? rest : req.denial;
      denials.push({ ...denial, by: resolved.decision.by, reason: resolved.decision.reason });
      return;
    }

    if (e.type === 'tool_request') {
      const request: ToolRequestEvent = e;
      const lost = request.decisionsLost;
      // Разрешённый политикой вопрос человеку решается `AskGate`, а не гейтом одобрений:
      // `tool_resolved` по нему не приходит, и запись висела бы до конца прогона. Отклонённый
      // политикой — приходит (гейт отказывает до проверки «шага человека нет»), и без записи
      // отказ AskHuman без права на этапе пропадал из отчёта.
      if (request.call.kind !== 'ask_human' || !request.policy.ok) {
        pending.set(request.requestId, {
          denial: {
            stage: request.stage,
            requestId: request.requestId,
            toolName: request.toolName,
            kind: request.call.kind,
            policy: request.policy.ok ? null : request.policy.policy,
            destructive: request.destructive,
            ...(lost === undefined ? {} : { decisionsLost: [...lost] }),
            // Перенаправленный гейтом вызов в событии уже канонический — по его пути
            // адресацию не узнать; признак — само перенаправление.
            ...(request.readdressed !== undefined || misaddressedOwnArtifact(request.call, args.projectRoot(), args.slug())
              ? { ownArtifactMisaddressed: true }
              : {}),
          },
          repairKinds: [
            ...(request.repaired !== undefined ? (['decision'] as const) : []),
            ...(request.readdressed !== undefined ? (['address'] as const) : []),
          ],
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
