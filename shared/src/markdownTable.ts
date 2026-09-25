/**
 * Разбор строки markdown-таблицы в ячейки — общий для сервера (`gates.md`, формы методологии)
 * и веба (рендер артефактов на дашборде).
 *
 * Жил в двух независимых копиях (`server/src/md/table.ts`, `web/src/lib/markdown.ts`) и
 * успел разойтись: серверная версия не считалась с обратными кавычками, и `|` внутри
 * `` `команда | filter` `` в колонке «Чем реализован» `gates.md` (человек пишет её сам,
 * не через `escapeCell`) резал ячейку пополам вместо честного парсинга гейта
 * (code-review-all, 2026-09-26). Веб-версия уже умела это — сведены сюда одним разбором.
 */

/**
 * Строка в ячейки. Вертикальная черта внутри значения экранируется как `\|`; внутри
 * `` `код` `` — литерал (там `|` может быть частью команды, не разделителем).
 */
export function splitRow(line: string): string[] {
  const cells: string[] = [];
  let cur = '';
  let inCode = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (ch === '\\' && line[i + 1] === '|') {
      cur += '|';
      i++;
      continue;
    }
    if (ch === '`') {
      inCode = !inCode;
      cur += ch;
      continue;
    }
    if (ch === '|' && !inCode) {
      cells.push(cur);
      cur = '';
      continue;
    }
    cur += ch;
  }
  cells.push(cur);
  if (cells.length > 0 && cells[0]!.trim() === '') cells.shift();
  if (cells.length > 0 && cells[cells.length - 1]!.trim() === '') cells.pop();
  return cells.map((c) => c.trim());
}
