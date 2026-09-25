/**
 * Какой файл дашборд вправе отдать по имени — закрытый словарь, а не путь.
 *
 * Ручка содержимого получает ИМЯ файла витка (`plan.md`, `.runner/iterations.md`), а не
 * путь: путь от клиента — это чтение произвольного файла машины (`../../.ssh/id_rsa`).
 * Словарь — канонические артефакты методологии (`isWitokArtifactName`), набор гейтов
 * проекта и служебные ОТЧЁТЫ раннера; лента, снимки baseline и картинки MCP не отдаются
 * (лента — отдельной ручкой деталей, baseline — хеши, картинки — десятки мегабайт).
 * После словаря — сверка `realpath`: symlink внутри каталога витка, ведущий наружу, имя
 * проходит, а путь — нет (тот же приём, что у гейта одобрений, `approval/gate.ts`).
 */

import { closeSync, openSync, readSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

import { RUNNER_DIR, WitokPaths, isWitokArtifactName } from '../artifacts/paths.ts';

/**
 * Служебный отчёт раннера или прежнее место журнала витка — по путям, которые строит
 * `artifacts/paths.ts` (единственное место, где имена артефактов превращаются в пути).
 * Номера chunk'а, попытки и маршрута берутся из самого имени и подставляются в методы
 * `WitokPaths`: словарь регулярками рядом с ними молча расходился бы с ними при переезде.
 */
function isServiceName(name: string): boolean {
  const p = new WitokPaths(PROBE_ROOT, PROBE_SLUG);
  const rel = (abs: string): string => relative(p.dir, abs).split(/[\\/]/).join('/');
  const [a = 1, b = 1, c = 1] = (name.match(/\d+/g) ?? []).map(Number);
  const candidates = [p.intentSections, p.iterations, p.iterationsLegacy, p.metricsReport, p.chunkSteps(a, b)];
  if (c > 0) candidates.push(p.verificationReport(a, b, c));
  return candidates.some((x) => rel(x) === name);
}

/** Условный корень и слаг — только чтобы спросить у `WitokPaths` форму имени. */
const PROBE_ROOT = resolve('/');
const PROBE_SLUG = 'probe';

/** Имя из словаря; без разделителей Windows, без `..`, без абсолютных путей. */
export function allowedWitokName(name: string): boolean {
  if (name === '' || name !== name.trim()) return false;
  if (name.includes('\\') || name.includes(':') || name.startsWith('/')) return false;
  if (name.split('/').some((seg) => seg === '..' || seg === '.' || seg === '')) return false;
  if (name === 'gates.md') return true;
  if (isServiceName(name)) return true;
  // Канонический артефакт — только базовым именем и в каноническом регистре: проверка
  // `isWitokArtifactName` сама по себе регистр не различает.
  return !name.includes('/') && /^[a-z0-9.-]+$/.test(name) && isWitokArtifactName(name);
}

export type Resolved = { abs: string } | { error: string; code: 400 | 404 };

function within(child: string, parent: string): boolean {
  const c = resolve(child);
  const p = resolve(parent);
  return c === p || c.startsWith(p.endsWith(sep) ? p : p + sep);
}

/** Абсолютный путь файла витка по имени либо причина отказа. */
export function resolveWitokArtifact(paths: WitokPaths, name: string): Resolved {
  if (!allowedWitokName(name)) return { error: `имя «${name}» не из словаря файлов витка`, code: 400 };
  const abs = name === 'gates.md' ? paths.gates : join(paths.dir, ...name.split('/'));
  const root = name === 'gates.md' ? join(paths.projectRoot, '.sdlc') : paths.dir;
  let real: string;
  let realRoot: string;
  try {
    real = realpathSync(abs);
    realRoot = realpathSync(root);
  } catch {
    return { error: `файла ${name} нет`, code: 404 };
  }
  if (!within(real, realRoot)) return { error: `${name} ведёт за пределы каталога витка`, code: 400 };
  try {
    if (!statSync(real).isFile()) return { error: `${name} — не файл`, code: 404 };
  } catch {
    return { error: `файла ${name} нет`, code: 404 };
  }
  return { abs: real };
}

/** Все файлы витка, которые отдаёт ручка содержимого, — абсолютные пути. */
export function listWitokArtifacts(paths: WitokPaths): string[] {
  const out: string[] = [];
  const add = (name: string, abs: string): void => {
    if (allowedWitokName(name)) out.push(abs);
  };
  try {
    for (const f of readdirSync(paths.dir)) add(f, join(paths.dir, f));
  } catch {
    /* каталога нет — отдавать нечего */
  }
  try {
    for (const f of readdirSync(join(paths.dir, RUNNER_DIR))) add(`${RUNNER_DIR}/${f}`, join(paths.dir, RUNNER_DIR, f));
  } catch {
    /* служебного каталога нет — терминальный виток */
  }
  try {
    if (statSync(paths.gates).isFile()) out.push(paths.gates);
  } catch {
    /* набора нет */
  }
  return out;
}

/** Потолок содержимого в одном ответе: больше — отдаётся начало с пометкой. */
export const MAX_ARTIFACT_BYTES = 512 * 1024;

/**
 * Файл с потолком. `from: 'tail'` — конец файла: у растущего лога хода прогона полезен
 * хвост (текущий этап, строка конца), а не шапка.
 */
export function readCapped(
  abs: string,
  cap: number = MAX_ARTIFACT_BYTES,
  from: 'head' | 'tail' = 'head',
): { text: string; sizeBytes: number; truncated: boolean; tail: boolean } {
  const size = statSync(abs).size;
  const len = Math.min(size, cap);
  const start = from === 'tail' ? size - len : 0;
  const buf = Buffer.alloc(len);
  const fd = openSync(abs, 'r');
  let read = 0;
  try {
    while (read < len) {
      const n = readSync(fd, buf, read, len - read, start + read);
      if (n === 0) break;
      read += n;
    }
  } finally {
    closeSync(fd);
  }
  // Только прочитанное: файл, усечённый между `stat` и чтением (повтор слага обнуляет лог),
  // иначе отдавал бы хвост из нулевых байтов.
  let text = buf.subarray(0, read).toString('utf8');
  const truncated = size > cap;
  if (truncated && from === 'tail') {
    // Хвост начинается с границы строки: первая строка куска — обрубок (у ленты — битый
    // JSON), её показывать незачем.
    const nl = text.indexOf('\n');
    text = nl >= 0 ? text.slice(nl + 1) : text.replace(/^�+/, '');
  } else if (truncated) {
    // Обрезка посреди многобайтного символа даёт «�» на краю — это артефакт потолка, не файла.
    text = text.replace(/�+$/, '');
  }
  return { text, sizeBytes: size, truncated, tail: truncated && from === 'tail' };
}

/** Файлы прогона стенда — закрытый словарь имён (пути к ним собирает `detail.ts::BENCH_FILES`). */
export const BENCH_ARTIFACTS = ['result.json', 'report.md', 'events.ndjson', 'progress.log'] as const;
export type BenchArtifactName = (typeof BENCH_ARTIFACTS)[number];

export function isBenchArtifactName(name: string): name is BenchArtifactName {
  return (BENCH_ARTIFACTS as readonly string[]).includes(name);
}
