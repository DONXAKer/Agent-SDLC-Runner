/**
 * Время последнего изменения карточки: свежее — относительно, старое — датой ЛОКАЛЬНОГО
 * времени. Детерминированно (без `toLocaleString`), чтобы тест не зависел от локали машины.
 * Невалидная строка возвращается как есть — показать что-то честнее, чем «Invalid Date».
 */
export function fmtUpdatedAt(iso: string, nowMs: number): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  const diff = Math.max(0, nowMs - t);
  const min = Math.floor(diff / 60_000);
  if (min < 1) return 'только что';
  if (min < 60) return `${min} мин назад`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} ч назад`;
  const d = new Date(t);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
