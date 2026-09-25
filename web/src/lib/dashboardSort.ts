import type { DashboardCard, DashboardCardRef } from '@sdlc-runner/shared';

/** Ключ карточки — React-ключ и сравнение «та же карточка» между опросами. */
export function cardKey(ref: DashboardCardRef): string {
  return `${ref.source}/${ref.project}/${ref.slug}`;
}

/**
 * Прогон идёт прямо сейчас: живой виток раннера или прогон стенда с живым процессом. ОДНО
 * правило на полосу «Сейчас идёт», подсветку на доске, фильтр «идут сейчас» и порядок.
 */
export function isRunningNow(c: Pick<DashboardCard, 'live' | 'bench'>): boolean {
  return c.live !== null || c.bench?.inProgress === true;
}

/**
 * Группа порядка: 0 — ждёт человека, 1 — идёт, 2 — всё остальное. Виток, стоящий на
 * решении, — единственный, где человек нужен прямо сейчас, и он не должен тонуть среди
 * сотен прогонов стенда.
 */
export function cardPriority(c: DashboardCard): 0 | 1 | 2 {
  // Идущий прогон стенда — тоже «идёт», хотя сервер им не управляет.
  if (c.live === null) return isRunningNow(c) ? 1 : 2;
  return c.live.waiting > 0 || c.live.status === 'awaiting' ? 0 : 1;
}

/** Группа, затем свежесть. Стабильно, вход не мутирует. */
export function sortCards(cards: readonly DashboardCard[]): DashboardCard[] {
  return [...cards].sort((a, b) => cardPriority(a) - cardPriority(b) || b.updatedAt.localeCompare(a.updatedAt));
}

/**
 * Та же ли это карточка. Виток терминала, продолженный в интерфейсе, меняет бейдж
 * `terminal` → `ui` — адрес открытой детали при этом прежний, и сравнение с источником
 * теряло карточку («больше нет в списке»), а деталь переставала обновляться.
 */
export function sameCard(a: DashboardCardRef, b: DashboardCardRef): boolean {
  if (a.project !== b.project || a.slug !== b.slug) return false;
  return (a.source === 'bench') === (b.source === 'bench');
}

/**
 * Неизменные карточки нового списка заменяются прежними объектами. Список разбирается из
 * JSON заново, и без этого каждая карточка была новым объектом — `memo` карточек не
 * срабатывал ни разу, и сотни карточек перерисовывались на каждое изменение одной.
 */
/** Сериализация прежних карточек — по объекту: прежняя карточка не сериализуется повторно. */
const cardJson = new WeakMap<DashboardCard, string>();

function jsonOf(c: DashboardCard): string {
  let s = cardJson.get(c);
  if (s === undefined) {
    s = JSON.stringify(c);
    cardJson.set(c, s);
  }
  return s;
}

export function reuseCards(prev: readonly DashboardCard[] | null, next: DashboardCard[]): DashboardCard[] {
  if (prev === null) return next;
  const old = new Map(prev.map((c) => [cardKey(c.ref), c]));
  return next.map((c) => {
    const o = old.get(cardKey(c.ref));
    if (o === undefined) return c;
    const s = JSON.stringify(c);
    if (jsonOf(o) === s) return o;
    cardJson.set(c, s);
    return c;
  });
}
