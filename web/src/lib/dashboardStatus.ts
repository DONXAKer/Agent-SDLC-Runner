import type { DashboardSource } from '@sdlc-runner/shared';

/**
 * Бейдж источника карточки дашборда. Ключ — `DashboardSource`: новый источник без подписи
 * должен ловиться сборкой.
 */
export const SOURCE_LABEL: Record<DashboardSource, string> = {
  ui: 'UI',
  terminal: 'терминал',
  bench: 'bench',
};

export const SOURCE_TONE: Record<DashboardSource, string> = {
  ui: 'bg-sky-900/60 text-sky-200',
  terminal: 'bg-violet-900/60 text-violet-200',
  bench: 'bg-teal-900/60 text-teal-200',
};

/** Что значит бейдж — в `title`: признак источника косвенный, и это надо говорить. */
export const SOURCE_HINT: Record<DashboardSource, string> = {
  ui: 'виток раннера: живой в памяти сервера или с лентой событий на диске',
  terminal: 'виток скиллов /sdlc-* из терминала: только артефакты, без ленты и чисел раннера',
  bench: 'прогон стенда (npm run bench): bench/results/<slug>.json',
};
