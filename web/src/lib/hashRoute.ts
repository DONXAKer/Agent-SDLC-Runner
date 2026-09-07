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

/** Вкладки режима наблюдения. Порядок — порядок кнопок на странице витка. */
export const OBS_TABS = ['events', 'diff', 'metrics', 'context'] as const;
export type ObsTab = (typeof OBS_TABS)[number];

export type Route =
  | { kind: 'start' }
  | { kind: 'run'; runId: string; view: 'now' }
  | { kind: 'run'; runId: string; view: 'obs'; tab: ObsTab }
  | { kind: 'archive'; project: string; slug: string };

const START: Route = { kind: 'start' };

/**
 * Разобрать hash. Всё непонятное — стартовый экран: чужая или устаревшая ссылка обязана
 * открыть рабочий экран, а не пустоту с ошибкой. `#/run/<id>` без режима — «Сейчас»:
 * старые ссылки и кнопки «назад» обязаны открывать виток, а не ломаться.
 */
export function parseHash(hash: string): Route {
  const raw = hash.startsWith('#') ? hash.slice(1) : hash;
  const parts = raw.replace(/^\/+/, '').split('/');
  const [kind, a, b, c] = parts;

  if (kind === 'run' && a !== undefined && a !== '') {
    const runId = decodeURIComponent(a);
    if (b === 'obs') {
      const tab = OBS_TABS.find((t) => t === c) ?? 'events';
      return { kind: 'run', runId, view: 'obs', tab };
    }
    return { kind: 'run', runId, view: 'now' };
  }
  if (kind === 'archive' && a !== undefined && a !== '' && b !== undefined && b !== '') {
    return { kind: 'archive', project: decodeURIComponent(a), slug: decodeURIComponent(b) };
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
  return '#/';
}
