/**
 * Хранение каталога: JSONL.
 *
 * Одна запись — одна строка JSON, файл — строки через `\n`. Формат — публичный контракт:
 * файлы каталога читают внешние службы (витрина, склад, выгрузка в бухгалтерию), и любое
 * изменение имён полей здесь — изменение для них. Поэтому набор и порядок полей в строке
 * закреплены явно, а не оставлены на усмотрение того, в каком порядке поля легли в объект:
 * diff двух выгрузок обязан показывать изменение данных, а не перестановку ключей.
 *
 * parse проверяет форму, а не доверяет JSON.parse: файл на диске мог написать кто угодно,
 * и «undefined в цене» всплыл бы не здесь, а в сумме заказа.
 */

import { product } from './product.ts';
import type { Product } from './product.ts';

/** Одна запись → одна строка JSON без переносов. Порядок полей — как в таблице README. */
export function serialize(p: Product): string {
  return JSON.stringify({ code: p.code, title: p.title, priceK: p.priceK });
}

/** Одна строка файла → запись. Всё, что не запись каталога, отвергается с названной причиной. */
export function parse(line: string): Product {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch (e) {
    throw new SyntaxError(`строка каталога не разбирается как JSON: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new TypeError('строка каталога — не объект');
  }
  const r = raw as Record<string, unknown>;
  const code = r['code'];
  const title = r['title'];
  const priceK = r['priceK'];
  if (typeof code !== 'string') throw new TypeError('в строке каталога нет артикула (code)');
  if (typeof title !== 'string') throw new TypeError('в строке каталога нет названия (title)');
  if (typeof priceK !== 'number') throw new TypeError('в строке каталога нет цены (priceK)');
  // Диапазоны — те же, что у конструктора: правило одно и на ввод, и на чтение с диска.
  return product(code, title, priceK);
}

/** Каталог → текст файла JSONL. Каждая строка завершена `\n`, чтобы файлы склеивались конкатенацией. */
export function saveAll(products: readonly Product[]): string {
  let text = '';
  for (const p of products) text += `${serialize(p)}\n`;
  return text;
}

/** Текст файла JSONL → каталог. Пустые строки (в т.ч. хвостовой перевод строки) записями не считаются. */
export function loadAll(text: string): Product[] {
  const out: Product[] = [];
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    out.push(parse(line));
  }
  return out;
}
