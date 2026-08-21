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
