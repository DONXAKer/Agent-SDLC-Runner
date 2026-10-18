/**
 * Адрес экрана в hash'е — без библиотеки роутинга.
 *
 * До этого «какой экран открыт» жило только в `useState`, и F5 посреди работающего витка
 * возвращал на стартовый экран: ссылку на виток дать было нельзя, кнопка «назад» браузера
 * не работала. В hash, а не в path, потому что статику раздаёт сам сервер и переписывать
 * его маршруты под history API ради этого незачем.
 *
 * Страница витка имеет два режима — «Сейчас» (управление) и «Наблюдение» (лента, дифф,
 * метрики, контекст) — и режим в адресе: вкладку наблюдения можно держать открытой ссылкой
 * и она переживает F5. Выбранный этап сюда по-прежнему не кладём: его ссылку давать незачем.
 */

import { DASHBOARD_SOURCES } from '@sdlc-runner/shared';
import type { DashboardCardRef } from '@sdlc-runner/shared';

/** Вкладки режима наблюдения. Порядок — порядок кнопок на странице витка. */
export const OBS_TABS = ['events', 'diff', 'metrics', 'context'] as const;
export type ObsTab = (typeof OBS_TABS)[number];

export type Route =
  | { kind: 'start' }
  | { kind: 'run'; runId: string; view: 'now' }
  | { kind: 'run'; runId: string; view: 'obs'; tab: ObsTab }
  | { kind: 'archive'; project: string; slug: string }
  /**
   * Дашборд запусков; `card` — открытая карточка. Фильтры в адрес не кладём: ссылку дают
   * на карточку, а не на «фильтр по стенду» (фильтры помнит localStorage).
   */
  | { kind: 'dashboard'; card: DashboardCardRef | null };

const START: Route = { kind: 'start' };

/**
 * Разобрать hash. Всё непонятное — стартовый экран: чужая или устаревшая ссылка обязана
 * открыть рабочий экран, а не пустоту с ошибкой. `#/run/<id>` без режима — «Сейчас»:
 * старые ссылки и кнопки «назад» обязаны открывать виток, а не ломаться.
 */
/**
 * Раскодировать сегмент; битая `%`-последовательность — `null`. `decodeURIComponent` на ней
 * бросает `URIError`, а разбор адреса идёт в инициализаторе состояния приложения: обрезанная
 * ссылка роняла весь интерфейс в белый экран вместо обещанного «непонятное — стартовый экран».
 */
function dec(s: string | undefined): string | null {
  if (s === undefined || s === '') return null;
  try {
    return decodeURIComponent(s);
  } catch {
    return null;
  }
}

export function parseHash(hash: string): Route {
  const raw = hash.startsWith('#') ? hash.slice(1) : hash;
  const parts = raw.replace(/^\/+/, '').split('/');
  const [kind, a, b, c] = parts;

  const runId = kind === 'run' ? dec(a) : null;
  if (runId !== null) {
    if (b === 'obs') {
      const tab = OBS_TABS.find((t) => t === c) ?? 'events';
      return { kind: 'run', runId, view: 'obs', tab };
    }
    return { kind: 'run', runId, view: 'now' };
  }
  if (kind === 'archive') {
    const project = dec(a);
    const slug = dec(b);
    if (project !== null && slug !== null) return { kind: 'archive', project, slug };
  }
  if (kind === 'dashboard') {
    // Битая или неполная карточка — сетка дашборда, а не старт: человек шёл сюда.
    const source = DASHBOARD_SOURCES.find((s) => s === a);
    const project = dec(b);
    const slug = dec(c);
    if (source !== undefined && project !== null && slug !== null) {
      return { kind: 'dashboard', card: { source, project, slug } };
    }
    return { kind: 'dashboard', card: null };
  }
  return START;
}

/**
 * Собрать hash. Сегменты кодируются: и slug, и имя проекта задаёт человек — в них
 * попадают пробелы, кириллица и слэши, а неэкранированный слэш разрезал бы адрес.
 */
export function formatHash(route: Route): string {
  if (route.kind === 'run') {
    if (route.view === 'obs') return `#/run/${encodeURIComponent(route.runId)}/obs/${route.tab}`;
    return `#/run/${encodeURIComponent(route.runId)}`;
  }
  if (route.kind === 'archive') {
    return `#/archive/${encodeURIComponent(route.project)}/${encodeURIComponent(route.slug)}`;
  }
  if (route.kind === 'dashboard') {
    if (route.card === null) return '#/dashboard';
    const { source, project, slug } = route.card;
    return `#/dashboard/${source}/${encodeURIComponent(project)}/${encodeURIComponent(slug)}`;
  }
  return '#/';
}
