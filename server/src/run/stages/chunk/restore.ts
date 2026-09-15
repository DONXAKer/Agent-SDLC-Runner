/**
 * Этап 5: номера chunk'а и попытки по файлам витка на диске — виток живёт на диске, и
 * пересозданный `Run` обязан продолжить с того места, где остановился прежний процесс.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';

import { columnIndex, parseTables } from '../../../md/table.ts';

/**
 * Восстанавливает номер ТЕКУЩЕГО chunk'а по файлам витка на диске.
 *
 * `restoreAttemptFromJournal` ниже чинит попытку внутри chunk'а, но сам `this.chunk`
 * до его вызова был захардкожен единицей в поле класса — рестарт процесса на chunk'е 3
 * откатывал счётчик в памяти на chunk 1, и `restoreAttemptFromJournal` смотрела не в тот
 * журнал вовсе. Наблюдение живого витка: случайный клик «Следующий chunk» сдвинул
 * состояние, откатить смог только `docker restart`, потому что перезапуск НЕ восстанавливал
 * то, что должен был. Берём наибольший `N`, для которого на диске есть `chunk-N-journal.md`
 * — тот же признак «chunk начался», на который опирается `restoreAttemptFromJournal`.
 */
export function restoreChunkFromDir(dir: string): number | null {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return null;
  }
  let max = 0;
  for (const name of entries) {
    const m = /^chunk-(\d+)-journal\.md$/.exec(name);
    if (m === null) continue;
    const n = Number.parseInt(m[1] as string, 10);
    if (Number.isFinite(n) && n > max) max = n;
  }
  return max > 0 ? max : null;
}

/**
 * Восстанавливает номер последней попытки chunk'а из журнала на диске.
 *
 * Новый `Run` в памяти всегда стартовал с попытки 1, даже если на диске уже лежат
 * артефакты попытки 3 — например, после рестарта сервера (виток живёт на диске, но
 * счётчик попытки был только в памяти процесса). Предусловие этапа верификации требует
 * `chunk-<N>-attempt-<K>-diff.patch` по ТЕКУЩЕМУ счётчику и падало «нет файла», хотя
 * реальный файл существовал под другим номером — единственным обходом было вручную
 * «прокликать» attempt 1→2→3 через кнопку «Новая попытка», рискуя случайно перезапустить
 * дорогой этап вместо того, чтобы просто продолжить его просмотр.
 */
export function restoreAttemptFromJournal(journalPath: string): number | null {
  if (!existsSync(journalPath)) return null;
  let text: string;
  try {
    text = readFileSync(journalPath, 'utf8');
  } catch {
    return null;
  }
  const table = parseTables(text).find((t) => t.section === 'Попытки');
  if (table === undefined || table.rows.length === 0) return null;
  const col = columnIndex(table.header, 'K');
  if (col === -1) return null;
  let max = 0;
  for (const row of table.rows) {
    const n = Number.parseInt(row[col] ?? '', 10);
    if (Number.isFinite(n) && n > max) max = n;
  }
  return max > 0 ? max : null;
}
