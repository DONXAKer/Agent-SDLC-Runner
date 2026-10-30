/**
 * Класс отказа клетки стенда — закрытый словарь поверх СТРУКТУРНЫХ полей результата
 * (`driver.stages[].failure/diagnostic/stopCause/envFailure`, `driver.incomplete`,
 * `guided.workload`), а не поверх текста заметки: заметка пишется человеческим языком и
 * меняется свободно, и регресс одного класса («все пять в `format` на chunk») должен быть
 * виден в сводке за один прогон, а не после чтения пяти трасс.
 */
import type { BenchResult } from './result.ts';
import type { DriverStageRecord } from './driver.ts';

export const FAILURE_CLASSES = [
  /** Полный цикл пройден, приёмка зелёная. */
  'none',
  /** Преполёт красный — модель не измерялась. */
  'preflight',
  /** Отказ среды: провайдер/движок/раскладка модели; прогон модель не измерил. */
  'env',
  /** Стенные часы: лимит этапа/витка, бюджет работы по времени, таймаут запроса, таймаут координатора. */
  'wall-clock',
  /** Выдача упёрлась в потолок токенов ответа. */
  'token-limit',
  /** Исчерпан лимит запросов/стоимости либо остановка по отсутствию прогресса. */
  'request-limit',
  /** Ответ не разобран: обрыв, tool calls вместо JSON, не-JSON. */
  'format',
  /** JSON разобран, но отклонён схемой действия/карточки. */
  'schema',
  /** Ответ по схеме, отклонён проверкой содержания: операция без источника, карта плана разошлась с кодом, инварианты. */
  'semantic',
  /** Артефакт этапа не готов по контракту (незаполненные поля, улики), ревью тут ни при чём. */
  'contract',
  /** Независимое ревью или проверка приёмки оставили замечания, и ремонт их не снял. */
  'review-rejected',
  /** Ремонт по замечаниям не изменил адресованную карточку; повтор ревью остановлен. */
  'review-stalled',
  /** Ревью не состоялось (ответ рецензента не разобран, пакет не поместился в окно). */
  'review-failed',
  /** Нужен человек: ответ на вопрос или решение, которого стенд дать не может. */
  'human-required',
  /** Результата нет или он чужой — стенд/координатор, а не модель. */
  'harness',
  /** Структурных признаков не хватило. */
  'unknown',
] as const;
export type FailureClass = typeof FAILURE_CLASSES[number];

export interface FailureClassInput {
  success: boolean;
  /** `status` из `assessGuidedValidation`. */
  status: string;
  environmentFailure?: boolean;
  /** Ошибка координатора матрицы (таймаут стенных часов, раскладка движка). */
  coordinatorError?: string | null;
  result: Pick<BenchResult, 'driver' | 'guided'> | null;
}

const WALLCLOCK_STOPS = new Set(['stage-timeout', 'run-timeout']);
const WALLCLOCK_CAUSES = new Set(['stage-deadline', 'request-timeout']);

function failedStage(result: FailureClassInput['result']): DriverStageRecord | undefined {
  return result?.driver.stages.find((stage) => !stage.ok);
}

/** Первое совпадение побеждает: порядок — от «модель не измерялась» к «модель ошиблась». */
export function classifyFailure(input: FailureClassInput): FailureClass {
  if (input.success) return 'none';
  if (input.status === 'preflight-failed') return 'preflight';
  const error = input.coordinatorError ?? '';
  if (/wall-clock timeout/iu.test(error)) return 'wall-clock';
  if (error !== '') return 'env';
  const result = input.result;
  if (result === null) return 'harness';
  const stage = failedStage(result);
  const failure = stage?.failure;
  const category = stage?.diagnostic?.category;
  const incomplete = result.driver.incomplete ?? stage?.incomplete;
  // Таймаут этапа/витка стенд относит к «среде» (`environmentFailure`), но класс отказа —
  // часы: именно их масштабирует паспорт скорости, и смешать их с 5xx провайдера значило бы
  // потерять сдвиг «wall-clock → …» после правки лимитов.
  if (WALLCLOCK_STOPS.has(result.driver.stopped) || (stage?.stopCause !== undefined && WALLCLOCK_CAUSES.has(stage.stopCause) && stage.envFailure === undefined)) return 'wall-clock';
  if (input.environmentFailure === true || stage?.envFailure !== undefined || failure?.kind === 'environment' || category === 'environment') return 'env';
  // Бюджет работы называет причину сам (`WorkIncomplete.cause`); `work-budget` без неё — часы.
  if (incomplete !== undefined) return incomplete.cause === 'wall-clock' ? 'wall-clock' : incomplete.cause === 'output-tokens' ? 'token-limit' : 'request-limit';
  if (stage?.stopCause === 'work-budget') return 'wall-clock';
  if (stage?.stopCause === 'token-limit') return 'token-limit';
  if (stage?.stopCause === 'no-progress' || category === 'budget') return 'request-limit';
  // Packing «context does not fit» — протокол/окно, не решение человека (series 2026-10-29).
  if (category === 'context-required') return 'harness';
  if (category === 'human-required') return 'human-required';
  if (failure?.reviewStatus === 'stalled') return 'review-stalled';
  if (failure?.reviewStatus === 'rejected') return 'review-rejected';
  if (failure?.reviewStatus === 'pending' || failure?.reviewStatus === 'stale') return 'review-failed';
  if (failure?.kind === 'format' || stage?.stopCause === 'schema') return failure?.kind === 'format' ? 'format' : 'schema';
  if (failure?.kind === 'operation' || failure?.kind === 'plan' || failure?.kind === 'checks' || category === 'semantic' || category === 'invalid-field' || category === 'invalid-evidence' || category === 'implementation') {
    // Операция отклонена после повторных выборок: класс — тот, на котором цикл остановился
    // (`guided.workload.failures` считает отказы по виду), иначе содержание.
    const counts = result.guided?.workload?.failures ?? {};
    const format = counts['format'] ?? 0, schema = counts['schema'] ?? 0;
    if (failure?.kind === 'operation' && format + schema > 0) return format >= schema ? 'format' : 'schema';
    return 'semantic';
  }
  if (failure?.kind === 'contract') return 'contract';
  if (category === 'invalid-response') {
    const counts = result.guided?.workload?.failures ?? {};
    return (counts['schema'] ?? 0) > (counts['format'] ?? 0) ? 'schema' : 'format';
  }
  if (category === 'unsupported' || category === 'stale' || category === 'runtime') return 'harness';
  // Красный verify / escalate (scope back-to-plan и т.п.) — контракт плана, не unknown
  // (granite add-validator/vat, 2026-10-29: mutation есть, Scope красный → escalate).
  if (result.driver.stopped === 'escalate') return 'contract';
  if (stage?.stage === 'verify' && stage.ok === false) return 'contract';
  if (stage === undefined && result.driver.stopped === 'blocked') return 'contract';
  const note = `${stage?.note ?? ''} ${result.driver.finalVerdict?.reasons?.join(' ') ?? ''}`;
  if (/Scope:\s*пути плана без правок|scope.*back-to-plan|files_to_touch/iu.test(note)) return 'contract';
  return 'unknown';
}

/** Сдвиг классов между двумя прогонами одной матрицы: ключ — модель×задача. */
export function compareFailureClasses(
  current: { key: string; failureClass: FailureClass }[],
  previous: { key: string; failureClass: FailureClass }[],
): { key: string; from: FailureClass | null; to: FailureClass; changed: boolean }[] {
  const before = new Map(previous.map((cell) => [cell.key, cell.failureClass]));
  return current.map((cell) => {
    const from = before.get(cell.key) ?? null;
    return { key: cell.key, from, to: cell.failureClass, changed: from !== null && from !== cell.failureClass };
  });
}
