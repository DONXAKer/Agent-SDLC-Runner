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

import { appendFileSync, closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync } from 'node:fs';
import { dirname } from 'node:path';

import type { RunEvent } from '@sdlc-runner/shared';

import { WitokPaths } from './artifacts/paths.ts';

/**
 * Дописывает одну запись. Синхронно и через `O_APPEND` — Node однопоточен, поэтому гонки
 * между конкурентными `emit` внутри одного процесса нет; `appendFileSync` с `O_APPEND`
 * атомарен и на уровне ОС для записей такого небольшого размера.
 *
 * `mkdirSync` — как и `writeArtifact` (`artifacts/artifact.ts`): `run_started` дописывается
 * СРАЗУ после создания `Run`, до первого артефакта методологии, когда `.sdlc/<slug>/` ещё
 * не существует — без создания каталога здесь эта и все последующие записи до первого
 * `writeArtifact` падали на ENOENT и молча терялись (лента archive-only, catch ниже её не
 * восстанавливает).
 */
/** Ленты, чей хвост этот процесс уже проверил на оборванную строку. */
const tailChecked = new Set<string>();

/**
 * Процесс, умерший посреди `appendFileSync`, оставляет в конце ленты строку без перевода
 * строки. Следующая запись приклеилась бы к ней, и склейка стала бы битой навсегда вместе с
 * событием нового процесса (обычно `run_started`). Проверяется один раз на ленту за процесс.
 */
function needsLeadingNewline(path: string): boolean {
  if (tailChecked.has(path)) return false;
  tailChecked.add(path);
  let fd: number;
  try {
    fd = openSync(path, 'r');
  } catch {
    return false;
  }
  try {
    const size = fstatSync(fd).size;
    if (size === 0) return false;
    const b = Buffer.alloc(1);
    readSync(fd, b, 0, 1, size - 1);
    return b[0] !== 0x0a;
  } finally {
    closeSync(fd);
  }
}

export function appendEvent(projectRoot: string, slug: string, event: RunEvent): void {
  const path = new WitokPaths(projectRoot, slug).events;
  const line = `${needsLeadingNewline(path) ? '\n' : ''}${JSON.stringify(event)}\n`;
  try {
    try {
      appendFileSync(path, line);
    } catch (e) {
      // `mkdirSync` — только по факту ENOENT (каталог витка ещё не создан, обычно на
      // самом первом событии), не на КАЖДЫЙ вызов: `emit()` в index.ts теперь прогоняет
      // сюда все события живого прогона, включая частый стрим `assistant_text`/`thinking`
      // — синхронный `mkdirSync` на каждое из них был бы лишним syscall'ом на горячем пути.
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      mkdirSync(dirname(path), { recursive: true });
      appendFileSync(path, line);
    }
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
  return parseEventsFile(new WitokPaths(projectRoot, slug).events, slug);
}

/**
 * Лента по пути файла — та же разборка для каталога витка и для копии ленты, которую стенд
 * сохраняет в `bench/traces/<slug>/events.ndjson`. `label` — имя в сообщениях об ошибке.
 */
export function parseEventsFile(path: string, label: string = path): RunEvent[] {
  if (!existsSync(path)) return [];

  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (e) {
    console.error(`[history] не удалось прочитать ленту витка ${label}: ${(e as Error).message}`);
    return [];
  }

  const out: RunEvent[] = [];
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    try {
      out.push(JSON.parse(line) as RunEvent);
    } catch {
      console.error(`[history] битая строка в ленте витка ${label} — пропущена`);
    }
  }
  return out;
}
