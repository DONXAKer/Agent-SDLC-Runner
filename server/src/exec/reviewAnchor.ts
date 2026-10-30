/**
 * Якорь замечания рецензента в тексте исходного запроса — тот же принцип, что
 * `anchorFound` у гейта «Ревью независимым агентом» на этапе 6: замечание, не
 * указывающее ни на одно место источника, ревью не является. Проверка чистая и общая
 * для ревью приёмки (intent) и независимого ревью плана: оба получают `requests`
 * дословно и отвечают полем `basis`.
 *
 * Якорем считается:
 *  - адрес `request-N:Lx[-Ly]`, указывающий на существующий запрос и строки в нём;
 *  - дословный фрагмент запроса: каждая цитата в «…»/"…"/`…` (если цитаты есть) либо
 *    всё поле целиком (если цитат нет), после нормализации — подстрока нормализованного
 *    запроса. Короткие фрагменты (меньше `MIN_ANCHOR_CHARS` знаков) совпадают случайно и
 *    якорем не считаются.
 */

export const MIN_ANCHOR_CHARS = 12;

/** Нормализация для сравнения: регистр, кавычки, пунктуация и пробелы не считаются. */
export function normalizeAnchorText(text: string): string {
  return text
    .toLocaleLowerCase()
    .replace(/[«»"'`“”‘’]/gu, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

const ADDRESS_RE = /request-(\d+):L(\d+)(?:-L(\d+))?/gu;

/** Адрес `request-N:Lx-Ly` действителен, когда запрос N существует и строки лежат в нём. */
export function anchorAddressValid(basis: string, requests: readonly string[]): boolean {
  for (const match of basis.matchAll(ADDRESS_RE)) {
    const request = requests[Number(match[1]) - 1];
    if (request === undefined) continue;
    const lines = request.split('\n').length;
    const start = Number(match[2]);
    const end = match[3] === undefined ? start : Number(match[3]);
    if (start >= 1 && end >= start && end <= lines) return true;
  }
  return false;
}

function quotedFragments(basis: string): string[] {
  const out: string[] = [];
  for (const match of basis.matchAll(/«([^»]+)»|"([^"]+)"|“([^”]+)”|`([^`]+)`/gu)) {
    const fragment = (match[1] ?? match[2] ?? match[3] ?? match[4] ?? '').trim();
    if (fragment !== '') out.push(fragment);
  }
  return out;
}

/** Есть ли у поля `basis` якорь в запросах. Без запросов проверка невозможна — считается якорем. */
export function anchoredInRequests(basis: string, requests: readonly string[]): boolean {
  if (requests.length === 0) return true;
  if (anchorAddressValid(basis, requests)) return true;
  const haystack = normalizeAnchorText(requests.join('\n'));
  if (haystack === '') return true;
  // Адрес без цитаты уже отклонён выше; остаток строки после адресов — сама цитата.
  const body = basis.replace(ADDRESS_RE, ' ');
  const quotes = quotedFragments(body);
  const fragments = quotes.length > 0 ? quotes : [body];
  return fragments.some((fragment) => {
    const needle = normalizeAnchorText(fragment);
    return needle.length >= MIN_ANCHOR_CHARS && haystack.includes(needle);
  });
}

export interface AnchoredSplit<T> {
  anchored: T[];
  /** Отброшенные замечания с причиной — для предупреждения, не для отказа. */
  dropped: { item: T; reason: string }[];
}

/** Разделить замечания по якорю; `basisOf` достаёт поле основания из элемента. */
export function splitByAnchor<T>(items: readonly T[], requests: readonly string[], basisOf: (item: T) => string | null): AnchoredSplit<T> {
  const anchored: T[] = [];
  const dropped: { item: T; reason: string }[] = [];
  for (const item of items) {
    const basis = basisOf(item);
    if (basis === null || anchoredInRequests(basis, requests)) anchored.push(item);
    else dropped.push({ item, reason: `замечание без основания в запросе отброшено: «${basis.slice(0, 160)}»` });
  }
  return { anchored, dropped };
}
