/**
 * Общие цветовые пары «рамка + фон» для панелей со статусом.
 *
 * Вынесены потому, что пара вердикта уже дублировалась между карточкой на странице витка и
 * строкой в ленте событий: компактные и полные варианты одного блока обязаны краситься из
 * одного места, иначе они молча разъедутся.
 */
export const PANEL_TONE = {
  ok: 'border-emerald-800 bg-emerald-950/30',
  fail: 'border-red-900 bg-red-950/30',
  warn: 'border-amber-900 bg-amber-950/30',
  neutral: 'border-neutral-800',
} as const;

/**
 * Палитра «рамка + текст» для бейджей статуса — общая для статуса ЭТАПА (`runStatus.ts`)
 * и статуса ВИТКА целиком (`historyStatus.ts`): разные домены, но одни и те же 4
 * семантических цвета для одинаковых по духу значений (готово/идёт/ждёт/провалено). Оба
 * файла раньше копировали эти четыре пары дословно — правка оттенка требовала синхронно
 * чинить оба места вручную.
 */
export const BADGE_TONE = {
  neutral: 'border-neutral-700 text-neutral-300',
  emerald: 'border-emerald-700 text-emerald-300',
  amber: 'border-amber-700 text-amber-300',
  red: 'border-red-800 text-red-300',
} as const;

/**
 * Вторичная кнопка-«обводка». Ровно та копипаста, ради которой выше вынесены
 * `PANEL_TONE`/`BADGE_TONE`: класс уже разошёлся по десятку файлов, новые места обязаны
 * брать его отсюда.
 */
export const BTN_SECONDARY =
  'rounded border border-neutral-700 text-neutral-300 hover:bg-neutral-800';

/** Тон панели вердикта — одно правило для карточки этапа и строки в ленте. */
export function verdictTone(passed: boolean): string {
  return passed ? PANEL_TONE.ok : PANEL_TONE.fail;
}

/**
 * Текстовый цвет вердикта — отдельно от рамки/фона: карточка на странице и строка в
 * ленте раньше красили текст по-своему (либо не красили вовсе), и один и тот же вердикт
 * выглядел по-разному на двух поверхностях.
 */
export function verdictTextTone(passed: boolean): string {
  return passed ? 'text-emerald-300' : 'text-red-300';
}

/** Тон счётчика красных вердиктов — общий для сводной строки и вкладки «Метрики». */
export function redCountTone(red: number): string {
  return red > 0 ? 'text-amber-400' : '';
}

/**
 * Раскраска строки unified-diff. Проверка `+++`/`---` обязательна: заголовки файлов
 * начинаются с тех же символов, что добавленные и удалённые строки.
 */
export function diffLineTone(line: string): string {
  if (line.startsWith('+') && !line.startsWith('+++')) return 'text-emerald-400';
  if (line.startsWith('-') && !line.startsWith('---')) return 'text-red-400';
  if (line.startsWith('@@')) return 'text-sky-400';
  return 'text-neutral-500';
}
