import type { DashboardStageState, FlowId } from '@sdlc-runner/shared';

import type { StageState } from './stageProgress.ts';

/**
 * Вид кружка этапа — один словарь на рельс страницы витка (`StageRail`) и полоску этапов
 * карточки дашборда (`StageStrip`). Пока словари жили внутри `StageRail`, второй экран
 * завёл бы свою копию, и «пройден» на двух поверхностях однажды покрасился бы по-разному.
 *
 * Ключ — объединение состояний обеих поверхностей: новое состояние без своего вида кружка
 * должно ловиться сборкой.
 */
export type StageTone = StageState | DashboardStageState;

// «Доступен» — голубой, а не зелёный: зелёный у пройденных, и одинаковый цвет в двух
// значениях («сделано» и «можно запускать») и был той путаницей, ради которой легенда.
export const CIRCLE: Record<StageTone, string> = {
  done: 'bg-emerald-900/70 text-emerald-300',
  running: 'animate-pulse bg-amber-600 text-black',
  available: 'bg-sky-800 text-sky-100 ring-2 ring-sky-500/50',
  blocked: 'bg-neutral-800 text-neutral-500',
  skipped: 'bg-neutral-800/60 text-neutral-400',
  notStarted: 'bg-neutral-900 text-neutral-600 ring-1 ring-neutral-800',
  failed: 'bg-red-900/70 text-red-300',
};

export const TITLE: Record<StageTone, string> = {
  done: 'text-neutral-400',
  running: 'text-neutral-200',
  available: 'text-neutral-200',
  blocked: 'text-neutral-500',
  skipped: 'text-neutral-500',
  notStarted: 'text-neutral-600',
  failed: 'text-red-300',
};

// Подпись состояния — цветом своего кружка.
export const STATE_LABEL: Record<StageTone, { text: string; cls: string }> = {
  done: { text: 'пройден', cls: 'text-emerald-500' },
  running: { text: 'выполняется', cls: 'text-amber-400' },
  available: { text: 'доступен', cls: 'text-sky-400' },
  blocked: { text: 'заблокирован', cls: 'text-amber-500' },
  skipped: { text: 'пропущен', cls: 'text-neutral-400' },
  notStarted: { text: 'не начат', cls: 'text-neutral-500' },
  failed: { text: 'провален', cls: 'text-red-400' },
};

// Ключ — `FlowId`, а не строка: новый флоу должен ловиться сборкой, а не оставаться
// без бейджа молча.
export const FLOW_BADGE: Record<FlowId, string> = {
  sdk: 'bg-violet-900/60 text-violet-200',
  loop: 'bg-teal-900/60 text-teal-200',
};

/** Знак в кружке: итог для закрытых состояний, номер этапа — для остальных. */
export function stageGlyph(tone: StageTone, idx: number): string {
  if (tone === 'done') return '✓';
  if (tone === 'failed') return '✗';
  if (tone === 'skipped') return '–';
  return String(idx + 1);
}
