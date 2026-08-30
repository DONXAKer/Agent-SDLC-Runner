/**
 * Подсказка строки набора гейтов по проскочившему дефекту.
 *
 * Замыкание цикла качества: ревью нашло дефект уже после того, как гейты дали зелёный, —
 * значит проверки на этот класс в наборе нет. Этап 7 предлагает человеку три варианта
 * (проверка, посев, принятый риск), и здесь готовится машинная часть первого и третьего:
 * готовая строка в форме набора.
 *
 * Что здесь НЕ делается: ничего не записывается в `.sdlc/gates.md`. Выбор из трёх —
 * решение человека, а гейт, добавленный за него, он же первым и выключит.
 *
 * Предложение прогоняется через собственный разбор рантайма (`parseGates` +
 * `configProblems`) ДО того, как попадёт человеку: строка, не проходящая свой же парсер, —
 * не предложение, а мусор в артефакте.
 */

import { BUILTIN } from './builtin/index.ts';
import { configProblems, gateKey, parseGates } from './gatesFile.ts';
import type { GatesFile } from './gatesFile.ts';

export interface GateSuggestion {
  /** Готовая строка таблицы набора — вставляется как есть. */
  row: string;
  /** Почему предложено именно это. */
  why: string;
  /** Есть ли встроенная реализация под этим именем. */
  builtin: boolean;
}

/** Имя строки уже занято: две строки с одним именем `configProblems` считает дефектом набора. */
function nameTaken(gates: GatesFile, name: string): boolean {
  return gates.rows.some((r) => gateKey(r.name) === gateKey(name));
}

/**
 * Строка проверки под проскочивший дефект.
 *
 * `null` — предложить нечего: имя занято, или собранная строка не прошла собственный
 * разбор. Молчание тут честнее выдумки.
 */
export function suggestCheckRow(
  gates: GatesFile,
  gatesText: string,
  name: string,
  command: string | null,
): GateSuggestion | null {
  if (name.trim() === '' || nameTaken(gates, name)) return null;

  const builtin = BUILTIN.has(gateKey(name));
  // У встроенной реализации команда не нужна: рантайм исполнит её сам. Для остальных без
  // команды строка бессмысленна — «чем реализован» будет прозой, и гейт останется прозой.
  if (!builtin && (command === null || command.trim() === '')) return null;

  const how = builtin ? 'встроенная проверка рантайма' : `\`${command?.trim() ?? ''}\``;
  // Черта в значениях экранируется: сырая `|` рвала бы колонки строки набора (class sweep).
  const esc = (s: string): string => s.replace(/\|/g, '\\|');
  const row = `| ${esc(name.trim())} | да | этап 6 | ${esc(how)} |`;

  // Проверка предложения собственным парсером: приписываем строку к тексту набора и
  // смотрим, не появилось ли новых претензий.
  const before = configProblems(gates).length;
  const candidate = parseGates(`${gatesText.replace(/\s+$/, '')}\n${row}\n`);
  if (candidate.rows.length !== gates.rows.length + 1) return null;
  if (configProblems(candidate).length > before) return null;

  return {
    row,
    why: builtin
      ? `у рантайма есть встроенная реализация «${name}» — команда не нужна`
      : `проверка исполняется командой, поэтому она названа явно`,
    builtin,
  };
}

/**
 * Строка принятого риска для журнала долга.
 *
 * Поля подобраны так, чтобы разбор считал долг закрытым: кто принял и когда. Подпись без
 * имени — незаполненный артефакт, и это правило здесь не смягчается.
 */
export function suggestDebtRow(what: string, who: string, date: string): string | null {
  if (what.trim() === '' || who.trim() === '' || date.trim() === '') return null;
  const esc = (s: string): string => s.replace(/\|/g, '\\|');
  return `| ${esc(what.trim())} | риск принят | ${esc(who.trim())} | ${esc(date.trim())} |`;
}
