/**
 * Обрезка захваченного вывода — общая для локального и docker-исполнителя песочницы, и для
 * `gates/shell.ts`. Раньше жила отдельной копией в каждом из трёх мест: правка лимита в
 * одном не долетала до других, и обрезка stdout вела себя по-разному в local/docker/gate-
 * путях без единой причины для расхождения.
 */

export const MAX_CAPTURE = 200_000;

export function cap(chunks: string[]): string {
  const joined = chunks.join('');
  return joined.length <= MAX_CAPTURE
    ? joined
    : `${joined.slice(0, MAX_CAPTURE / 2)}\n…[обрезано рантаймом]…\n${joined.slice(-MAX_CAPTURE / 2)}`;
}
