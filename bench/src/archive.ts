/**
 * Архив прогонов стенда: старые результаты и трассы уезжают в `bench/archive/{results,traces}`
 * той же раскладки, на месте остаётся ОДИН прогон на базовую модель — самый последний по началу.
 *
 * Ключ — базовая модель (`baseModel`), а не id маршрута: id несёт провайдера и ручки
 * (`ollama:gpt-oss-20b-agent-stepfill`, `lmstudio:gpt-oss-20b-f16`), и «по одному на id»
 * оставляло девятнадцать карточек одного gpt-oss-20b. Доска показывает текущую картину по
 * моделям, история (прежние настройки, провайдеры, задачи, посевы) — в архиве, откуда её
 * открывает фильтр дашборда. Новая серия снова даёт две карточки — скрипт запускается заново.
 *
 * Архив, а не удаление: `docs/model-runs.md` ссылается на отчёты, и вердикты обязаны
 * оставаться перепроверяемыми. Поэтому те же ссылки в документах переписываются на новый путь.
 * Дашборд читает архив вторым индексом (`DASHBOARD_BENCH_ARCHIVE`) и показывает его фильтром.
 *
 * Идущие прогоны не трогаются: каталог трассы, изменённый за последние `BUSY_MS`, — признак
 * живого процесса (файл состояния переписывается переименованием на каждый пульс).
 * Без `--apply` только печатает план.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Правка трассы или файла свежее этого — прогон может идти прямо сейчас. */
const BUSY_MS = 10 * 60_000;

export interface RunFacts {
  slug: string;
  model: string;
  /** Начало прогона; нет даты в результате — время файла. */
  startedMs: number;
}

/**
 * Хвостовые части id, которые называют настройку, а не веса: ручки раннера, окно контекста,
 * квантование, вариант шаблона, организация-публикатор.
 */
// `effort`/`high`/`low` остаются здесь намеренно: тот же вес модели под другим значением
// reasoning effort (`docs/model-runs.md`: «тот же вес», «заведены две новые записи для
// того же веса — gpt-oss-20b-effort-low-rf/-high-rf») — настройка, не другие веса.
// `instruct`/`reasoning` сюда НЕ идут: `ministral3-14b-instruct` и `ministral3-14b-reasoning`
// — разные обученные варианты с разной пригодностью по этапам (`docs/model-task-matrix.md`),
// а не одна модель под разным параметром; слитые в одну базовую модель, они бы делили одну
// карточку доски и одну строку архивного «оставить последний» между собой.
const KNOB_PARTS = new Set([
  'stepfill', 'compactfill', 'axisfill', 'explorefill', 'exploreindex', 'selfreview', 'nofill', 'dyn', 'mt',
  'rf', 'ff', 'agent', 'inputs', 'reviewer', 'effort', 'high', 'low', 'f16', 'iq4',
  'zaiorg', '2512',
]);

/** Одна модель под разными написаниями тегов у разных провайдеров. */
const BASE_ALIASES: ReadonlyMap<string, string> = new Map([
  ['qwen38-27b', 'qwen3.8-27b'],
  ['qwen3-coder-30b-a3b', 'qwen3-coder-30b'],
]);

/**
 * Базовая модель id маршрута: без провайдера и публикатора (`lmstudio:qwen/…`), без ручек
 * и окна в хвосте, `gemma-4` = `gemma4`, `qwen3:8b` = `qwen3-8b`.
 */
export function baseModel(id: string): string {
  let s = id.toLowerCase().replace(/^[^:]+:/, '').replace(/^.*\//, '').replace(/:/g, '-');
  s = s.replace(/^([a-z]+)-(\d)/, '$1$2');
  const parts = s.split('-');
  while (parts.length > 1) {
    const last = parts[parts.length - 1]!;
    if (KNOB_PARTS.has(last) || /^(ctx)?\d+k$/.test(last)) parts.pop();
    else break;
  }
  const b = parts.join('-');
  return BASE_ALIASES.get(b) ?? b;
}

/** Слаги, которые остаются: последний прогон каждой базовой модели. */
export function planKeep(runs: readonly RunFacts[]): Set<string> {
  const latest = new Map<string, RunFacts>();
  for (const r of runs) {
    const key = baseModel(r.model);
    const prev = latest.get(key);
    // При равном начале побеждает больший слаг — план не зависит от порядка чтения каталога.
    if (prev === undefined || r.startedMs > prev.startedMs || (r.startedMs === prev.startedMs && r.slug > prev.slug)) latest.set(key, r);
  }
  return new Set([...latest.values()].map((r) => r.slug));
}

const obj = (v: unknown): Record<string, unknown> | null =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

/** Факты прогона из `result.json`; не результат стенда (сводка серии, битый файл) — `null`. */
export function runFacts(v: unknown, slug: string, fileMtimeMs: number): RunFacts | null {
  const run = obj(obj(v)?.['run']);
  if (run === null || typeof run['model'] !== 'string') return null;
  const started = Date.parse(typeof run['startedAt'] === 'string' ? run['startedAt'] : '');
  return { slug, model: run['model'], startedMs: Number.isNaN(started) ? fileMtimeMs : started };
}

/**
 * Ссылки `bench/results/<имя>` на уехавшие файлы — на `bench/archive/results/<имя>`.
 * Имя сверяется целиком (с расширением или голым слагом), чтобы `x-1` не задел `x-10`.
 */
export function rewriteLinks(text: string, movedFiles: ReadonlySet<string>, movedSlugs: ReadonlySet<string>): string {
  return text.replace(/(?<!archive\/)bench\/results\/([A-Za-z0-9._-]+)/g, (whole, name: string) => {
    // Точка в конце — конец предложения, а не часть имени.
    const bare = name.replace(/\.+$/, '');
    const slug = bare.replace(/\.(report\.md|json)$/, '');
    return movedFiles.has(bare) || movedSlugs.has(bare) || (bare !== slug && movedSlugs.has(slug))
      ? `bench/archive/results/${name}`
      : whole;
  });
}

interface Move {
  from: string;
  to: string;
}

function mtimeMs(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}

/** Документы, где встречаются ссылки на результаты стенда. */
function docFiles(repo: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const n of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, n.name);
      if (n.isDirectory()) walk(p);
      else if (n.name.endsWith('.md')) out.push(p);
    }
  };
  if (existsSync(join(repo, 'docs'))) walk(join(repo, 'docs'));
  for (const f of ['CLAUDE.md', 'README.md', 'bench/README.md', 'bench/ROADMAP.md']) if (existsSync(join(repo, f))) out.push(join(repo, f));
  return out;
}

function main(argv: string[]): void {
  const bench = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const repo = resolve(bench, '..');
  const apply = argv.includes('--apply');
  const results = join(bench, 'results');
  const traces = join(bench, 'traces');
  const archive = join(bench, 'archive');
  const busySince = Date.now() - BUSY_MS;
  const busy = (path: string): boolean => mtimeMs(path) >= busySince;

  const files = readdirSync(results);
  const runs: RunFacts[] = [];
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    const slug = f.slice(0, -'.json'.length);
    try {
      const facts = runFacts(JSON.parse(readFileSync(join(results, f), 'utf8')), slug, mtimeMs(join(results, f)));
      if (facts !== null) runs.push(facts);
    } catch {
      /* битый JSON — уходит в архив ниже как прочий файл */
    }
  }
  const keep = planKeep(runs);
  const resultSlugs = new Set(runs.map((r) => r.slug));

  const moves: Move[] = [];
  const skipped: string[] = [];
  const movedFiles = new Set<string>();
  const movedSlugs = new Set<string>();

  for (const r of runs) {
    if (keep.has(r.slug)) continue;
    // Слаг перезапущен и идёт — его трасса живая, результат перепишется на месте.
    if (busy(join(traces, r.slug))) {
      skipped.push(`${r.slug}: трасса правилась только что — прогон может идти`);
      continue;
    }
    movedSlugs.add(r.slug);
    for (const f of [`${r.slug}.json`, `${r.slug}.report.md`]) {
      if (!existsSync(join(results, f))) continue;
      moves.push({ from: join(results, f), to: join(archive, 'results', f) });
      movedFiles.add(f);
    }
    if (existsSync(join(traces, r.slug))) moves.push({ from: join(traces, r.slug), to: join(archive, 'traces', r.slug) });
  }
  // Прочее в `results/` (логи серий, сводки, битые JSON, отчёты без результата).
  for (const f of files) {
    const slug = f.replace(/\.(report\.md|json)$/, '');
    if (resultSlugs.has(slug) && (f === `${slug}.json` || f === `${slug}.report.md`)) continue;
    if (busy(join(results, f))) continue;
    moves.push({ from: join(results, f), to: join(archive, 'results', f) });
    movedFiles.add(f);
  }
  // Трассы без результата (убитые прогоны). Только каталоги: лежащие рядом логи и сводки
  // серий пишет идущий скрипт серии. `raw` — сырой дамп запросов, не прогон.
  if (existsSync(traces)) {
    for (const n of readdirSync(traces, { withFileTypes: true })) {
      const d = n.name;
      if (!n.isDirectory() || d === 'raw' || resultSlugs.has(d)) continue;
      if (busy(join(traces, d))) {
        skipped.push(`${d}: трасса без результата правилась только что — прогон идёт`);
        continue;
      }
      moves.push({ from: join(traces, d), to: join(archive, 'traces', d) });
    }
  }

  // Коллизия имени: архив уже держит файл с этим именем (тот же слаг архивировался раньше
  // отдельным прогоном стенда). Переместить нечем — файл остаётся в `results/`, и здесь же
  // его слаг/файлы вычёркиваются из movedFiles/movedSlugs ДО подсчёта ссылок в документах:
  // иначе ссылка переписывалась бы на `bench/archive/results/<имя>`, хотя там лежит чужой
  // прежний файл с тем же именем, а актуальный результат молча остался неархивированным
  // (code-review-all, 2026-09-26).
  const appliedMoves = moves.filter((m) => !existsSync(m.to));
  for (const m of moves) {
    if (!existsSync(m.to)) continue;
    const base = m.from.split(/[\\/]/).pop()!;
    const slug = base.replace(/\.(report\.md|json)$/, '');
    movedSlugs.delete(slug);
    movedFiles.delete(`${slug}.json`);
    movedFiles.delete(`${slug}.report.md`);
    skipped.push(`${base}: в архиве уже есть файл с этим именем — оставлен в results/, разберись вручную`);
  }

  console.log(`прогонов с результатом: ${runs.length}; остаются: ${keep.size} (по одному на базовую модель)`);
  console.log(`в архив: прогонов ${movedSlugs.size}, перемещений ${appliedMoves.length}`);
  for (const s of skipped) console.log(`  пропущен ${s}`);
  const byModel = new Map(runs.filter((r) => keep.has(r.slug)).map((r) => [baseModel(r.model), r]));
  for (const [base, r] of [...byModel].sort()) console.log(`  остаётся ${base} — ${r.model} · ${r.slug} (${new Date(r.startedMs).toISOString().slice(0, 16)})`);

  const docChanges: { path: string; text: string; count: number }[] = [];
  for (const p of docFiles(repo)) {
    const text = readFileSync(p, 'utf8');
    const next = rewriteLinks(text, movedFiles, movedSlugs);
    if (next !== text) {
      const count = (text.match(/(?<!archive\/)bench\/results\//g)?.length ?? 0) - (next.match(/(?<!archive\/)bench\/results\//g)?.length ?? 0);
      docChanges.push({ path: p, text: next, count });
    }
  }
  for (const d of docChanges) console.log(`  ссылки: ${relative(repo, d.path)} — ${d.count}`);

  if (!apply) {
    console.log('пробный прогон: ничего не перемещено (добавь --apply)');
    return;
  }
  mkdirSync(join(archive, 'results'), { recursive: true });
  mkdirSync(join(archive, 'traces'), { recursive: true });
  let done = 0;
  for (const m of appliedMoves) {
    // Защитная повторная проверка: коллизии уже отфильтрованы выше (до подсчёта ссылок),
    // но дерево могло измениться между планом и применением.
    if (existsSync(m.to)) continue;
    renameSync(m.from, m.to);
    done += 1;
  }
  for (const d of docChanges) writeFileSync(d.path, d.text);
  console.log(`перемещено: ${done}; документов переписано: ${docChanges.length}`);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
