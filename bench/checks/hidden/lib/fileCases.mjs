/**
 * Файловые кейсы эталона — второй формат рядом с `call`/`order`/`bill`.
 *
 * Для задач, где результат — текст, а не функция (`docs-sync`: README и комментарии обязаны
 * перестать врать). Кейс описывает файл цели и что в нём обязано быть / не быть:
 *
 *   { "file": "README.md",
 *     "mustContain":    ["по убыванию", { "regex": "порог\\s+включ", "flags": "iu" }],
 *     "mustNotContain": ["по возрастанию"] }
 *
 * Строка — дословная подстрока; объект `{ regex, flags? }` — регулярное выражение.
 * Отсутствующий файл — провал кейса с понятным текстом, не ENOENT.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

function matcher(m) {
  if (typeof m === 'string') return { test: (text) => text.includes(m), show: JSON.stringify(m) };
  const re = new RegExp(m.regex, m.flags ?? 'u');
  return { test: (text) => re.test(text), show: `/${m.regex}/${m.flags ?? 'u'}` };
}

/** Проверяет кейс; возвращает список нарушений (пусто — кейс зелёный). */
export function fileCaseProblems(target, c) {
  const path = join(target, c.file);
  if (!existsSync(path)) return [`файла ${c.file} в цели нет`];
  const text = readFileSync(path, 'utf8');
  const problems = [];
  for (const m of c.mustContain ?? []) {
    const k = matcher(m);
    if (!k.test(text)) problems.push(`${c.file}: нет ожидаемого ${k.show}`);
  }
  for (const m of c.mustNotContain ?? []) {
    const k = matcher(m);
    if (k.test(text)) problems.push(`${c.file}: осталось запрещённое ${k.show}`);
  }
  return problems;
}

/** Бросает с перечнем нарушений — форма для `it()`. */
export function assertFileCase(target, c) {
  const problems = fileCaseProblems(target, c);
  if (problems.length > 0) throw new Error(problems.join('\n'));
}
