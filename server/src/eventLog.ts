/**
 * Персистентная лента событий витка — на диск, не только в память.
 *
 * `EventBus` (`bus.ts`) держит ленту в памяти процесса с capped-буфером; она пропадает при
 * рестарте сервера и при «Убрать» (`runs.delete`/`bus.forget`). Без записи на диск «история
 * витков» умела показать только финальный статус и этап (`history.ts`), а не саму
 * последовательность событий каждого этапа — то есть не давала реально «открыть пройденный
 * процесс и посмотреть, что было».
 *
 * Формат — NDJSON (одна `RunEvent`-запись на строку), дописывается по мере эмита, живёт на
 * ВЕСЬ виток (`WitokPaths.events`, ключ — `slug`), не на один процесс: `Run.id`
 * (`randomUUID()`) не переживает рестарт, слаг — переживает.
 */

import { appendFileSync, existsSync, readFileSync } from 'node:fs';

import type { RunEvent } from '@sdlc-runner/shared';

import { WitokPaths } from './artifacts/paths.ts';

/**
 * Дописывает одну запись. Синхронно и через `O_APPEND` — Node однопоточен, поэтому гонки
 * между конкурентными `emit` внутри одного процесса нет; `appendFileSync` с `O_APPEND`
 * атомарен и на уровне ОС для записей такого небольшого размера.
 */
export function appendEvent(projectRoot: string, slug: string, event: RunEvent): void {
  const path = new WitokPaths(projectRoot, slug).events;
  try {
    appendFileSync(path, `${JSON.stringify(event)}\n`);
  } catch (e) {
    // Лента — вспомогательный архив, не источник истины для самого прогона: ошибка записи
    // (диск полон, права) не должна ронять виток, только лишать его архивной ленты.
    console.error(`[history] не удалось дописать событие витка ${slug}: ${(e as Error).message}`);
  }
}

/**
 * Читает всю ленту витка. `[]` — файла нет (виток ещё не начинался или заведён до появления
 * этого механизма). Одна битая строка (обрыв записи при падении процесса ровно посреди
 * `appendFileSync`) не должна ронять чтение остальных — пропускается с предупреждением.
 */
export function readPersistedEvents(projectRoot: string, slug: string): RunEvent[] {
  const path = new WitokPaths(projectRoot, slug).events;
  if (!existsSync(path)) return [];

  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (e) {
    console.error(`[history] не удалось прочитать ленту витка ${slug}: ${(e as Error).message}`);
    return [];
  }

  const out: RunEvent[] = [];
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    try {
      out.push(JSON.parse(line) as RunEvent);
    } catch {
      console.error(`[history] битая строка в ленте витка ${slug} — пропущена`);
    }
  }
  return out;
}
