/**
 * Адрес экрана в hash'е — без библиотеки роутинга.
 *
 * До этого «какой экран открыт» жило только в `useState`, и F5 посреди работающего витка
 * возвращал на стартовый экран: ссылку на виток дать было нельзя, кнопка «назад» браузера
 * не работала. В hash, а не в path, потому что статику раздаёт сам сервер и переписывать
 * его маршруты под history API ради этого незачем.
 *
 * Внутренние состояния страницы витка (вкладка, выбранный этап) сюда НЕ кладутся: два
 * источника истины на одно состояние — обычный источник рассогласований, а выгоды от
 * ссылки на вкладку нет.
 */

export type Route =
  | { kind: 'start' }
  | { kind: 'run'; runId: string }
  | { kind: 'archive'; project: string; slug: string };

const START: Route = { kind: 'start' };

/**
 * Разобрать hash. Всё непонятное — стартовый экран: чужая или устаревшая ссылка обязана
 * открыть рабочий экран, а не пустоту с ошибкой.
 */
export function parseHash(hash: string): Route {
  const raw = hash.startsWith('#') ? hash.slice(1) : hash;
  const parts = raw.replace(/^\/+/, '').split('/');
  const [kind, a, b] = parts;

  if (kind === 'run' && a !== undefined && a !== '') {
    return { kind: 'run', runId: decodeURIComponent(a) };
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
  if (route.kind === 'run') return `#/run/${encodeURIComponent(route.runId)}`;
  if (route.kind === 'archive') {
    return `#/archive/${encodeURIComponent(route.project)}/${encodeURIComponent(route.slug)}`;
  }
  return '#/';
}
