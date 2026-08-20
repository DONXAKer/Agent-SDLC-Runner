/**
 * Эвристика «написал то, что уже есть»: одноимённые хелперы.
 *
 * Ловит типовой класс — исполнитель пишет `formatDate`, не заметив, что такая функция уже
 * лежит в `utils/`. Проверка дешёвая и языко-агностичная: имена объявлений из diff'а
 * ищутся в остальном дереве.
 *
 * Исход этого гейта — НЕ `❌`. Находка эвристики не является нарушением: одноимённая
 * функция в другом модуле бывает совершенно законной. Правильный исход — `⏭` с вопросом,
 * требующим подписи человека о неприменимости: так гейт не врёт и не блокирует.
 *
 * Здесь только правило, без файловой системы: список файлов и их содержимое подаёт
 * вызывающий.
 */

import { declaredFunctionNames } from '../ecosystems/index.ts';
import type { DiffLine } from './logic.ts';
// Признак тестового файла берётся из общего места: копия здесь уже теряла хвост для
// JVM и .NET, и гейт рапортовал о дублях на тестовых хелперах.
import { TEST_FILE } from './logic.ts';

/**
 * Слишком общие имена: одноимённость таких ничего не значит, а шум они дают на каждом
 * витке. Гейт, который кричит всегда, приучает себя игнорировать.
 */
const TOO_COMMON = new Set([
  'run', 'get', 'set', 'main', 'init', 'new', 'test', 'setup', 'start', 'stop',
  'read', 'write', 'load', 'save', 'parse', 'build', 'render', 'handle', 'update',
  'create', 'delete', 'remove', 'add', 'has', 'is', 'to', 'from', 'of', 'apply',
]);

/** Короче четырёх символов — почти наверняка `id`, `fn`, `ok`: совпадение неинформативно. */
const MIN_NAME = 4;

function isTestFile(file: string): boolean {
  return TEST_FILE.test(file);
}

/** Имена функций, ДОБАВЛЕННЫХ этим diff'ом, вместе с файлом, где они появились. */
export function addedFunctionNames(lines: readonly DiffLine[]): { name: string; file: string }[] {
  const out: { name: string; file: string }[] = [];
  const seen = new Set<string>();

  for (const l of lines) {
    // Тестовые файлы не смотрим: одноимённые хелперы в тестах — норма и шум.
    if (!l.added || isTestFile(l.file)) continue;
    for (const name of declaredFunctionNames(l.text.replace(/^\+/, ''))) {
      if (name.length < MIN_NAME || TOO_COMMON.has(name.toLowerCase())) continue;
      const key = `${l.file}:${name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ name, file: l.file });
    }
  }
  return out;
}

export interface DuplicateFinding {
  name: string;
  /** Файл, где имя добавлено этим витком. */
  addedIn: string;
  /** Файл, где такое же объявление уже было. */
  existsIn: string;
}

/**
 * Каталоги, где «общий» код лежит чаще всего. Порядок влияет только на приоритет показа:
 * совпадение в `shared/` подозрительнее, чем в соседнем модуле.
 */
const COMMON_DIRS = ['shared/', 'utils/', 'util/', 'common/', 'lib/', 'helpers/', 'core/'];

function rank(file: string): number {
  const i = COMMON_DIRS.findIndex((d) => file.includes(d));
  return i < 0 ? COMMON_DIRS.length : i;
}

/**
 * Сопоставляет добавленные имена с уже существующими объявлениями в дереве.
 *
 * `readFile` возвращает `null`, если файл нечитаем, — гейт от этого не падает: он
 * эвристический, и один нечитаемый файл не повод отказываться от остальных находок.
 */
export function findDuplicates(
  added: readonly { name: string; file: string }[],
  projectFiles: readonly string[],
  readFile: (file: string) => string | null,
): DuplicateFinding[] {
  if (added.length === 0) return [];

  const touched = new Set(added.map((a) => a.file));
  const candidates = projectFiles.filter((f) => !touched.has(f) && !isTestFile(f));
  const out: DuplicateFinding[] = [];

  for (const file of candidates) {
    const text = readFile(file);
    if (text === null) continue;

    for (const line of text.split(/\r?\n/)) {
      const names = declaredFunctionNames(line);
      if (names.length === 0) continue;
      for (const a of added) {
        if (!names.includes(a.name)) continue;
        if (out.some((f) => f.name === a.name && f.existsIn === file)) continue;
        out.push({ name: a.name, addedIn: a.file, existsIn: file });
      }
    }
  }

  return out.sort((x, y) => rank(x.existsIn) - rank(y.existsIn));
}
