/**
 * Сборка проверенного SFT-корпуса из сырых обменов провайдера.
 *
 * В корпус попадает только обмен с явной положительной sidecar-меткой. Итог этапа или
 * всего витка намеренно не используется как метка отдельного ответа: один зелёный этап
 * может содержать несколько неудачных ремонтов до успешного, а красный — верную правку,
 * после которой упал независимый гейт.
 *
 * Этот файл инвариант НЕ ПРОВЕРЯЕТ — он держится только тем, что все шесть текущих
 * писателей меток (`LoopExecutor`, `StepExecutor`, `FormFillExecutor` — оба пути,
 * `claimFill`, `reviewFill`, `planAxisFill`/`planAxisStepwise`) берут `accepted` из
 * ЛОКАЛЬНОГО механического оракула конкретного обмена (`applyFill`, `parseFieldValue`,
 * контракт «ровно N строк», гейт после шага), а не из `finalVerdict`/итога прогона.
 * `buildCorpus` не читает `result.json` дальше `run.slug`/`run.task` (см. `resultTasks`) —
 * если будущий аннотатор (например, для этапа `handoff`) положит в `.label.json`
 * `accepted`, пересказанное из итогового вердикта витка, ничто здесь этого не поймает
 * (code-review-all, 2026-09-27). Проверка (`corpus.test.ts`, «не угадывает качество по
 * результату витка без sidecar-метки») покрывает симметричный случай — отсутствие
 * фолбэка на вердикт при ОТСУТСТВИИ метки, — но не подмену метки исходом витка ПРИ ЕЁ
 * наличии: это открытый риск, а не решённая проверка.
 */

import { mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { ExchangeLabel } from '@sdlc-runner/shared';

const TRAINABLE_MODES = new Set(['step', 'formFill', 'claimFill', 'reviewFill', 'planAxisFill']);
const HELD_OUT_TASKS = new Set(['oversize']);

interface RawExchange {
  slug: string;
  stage: string;
  mode: string;
  provider: string;
  model: string;
  status: number;
  request: { messages?: unknown; tools?: unknown };
  response: string;
}

// `ExchangeLabel` (`@sdlc-runner/shared`) — тот же тип, что пишет `server/src/provider/
// rawLog.ts::annotateExchange`; читается здесь как `unknown`-safe JSON, поэтому проверки
// `typeof label.oracle === 'string'` ниже остаются: файл на диске мог быть написан старой
// версией писателя или битым процессом, и типу доверять на этапе выполнения нельзя, только
// на этапе компиляции (переименование поля в писателе теперь ловится ЗДЕСЬ же — та самая
// защита, которой раньше не было, code-review-all, 2026-09-27).

export interface CorpusExample {
  messages: unknown[];
  tools?: unknown;
  metadata: {
    slug: string;
    task: string;
    stage: string;
    mode: string;
    provider: string;
    model: string;
    oracle: string;
    target: string;
    source: string;
  };
}

export interface CorpusReport {
  scanned: number;
  accepted: number;
  rejected: Record<string, number>;
  tasks: Record<string, number>;
  modes: Record<string, number>;
  /**
   * Слаги, встретившиеся в `resultsDir` больше одного раза с РАЗНОЙ задачей (архивный
   * результат + новый прогон с тем же слагом, например). Атрибуция задачи для такого
   * слага решается по времени изменения файла (новее — побеждает), а не порядком
   * `readdirSync`, но сам факт коллизии называется здесь, а не тонет молча
   * (code-review-all, 2026-09-27): порча атрибуции задачи для ВСЕХ обменов этого слага
   * иначе была бы не видна ни в чём, кроме самого корпуса.
   */
  slugTaskConflicts: string[];
}

function bump(map: Record<string, number>, key: string): void {
  map[key] = (map[key] ?? 0) + 1;
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8')) as unknown;
}

/**
 * Слаг → задача. Коллизия (один слаг в двух файлах результата с РАЗНОЙ задачей) решается
 * по mtime файла — новее побеждает, тот же признак, что уже используют `bench/src/archive.ts`
 * (там `busy`) и дашборд для «какой прогон свежий» — не порядком `readdirSync`, который
 * не гарантирован даже стабильным между запусками ОС. Коллизии возвращаются отдельно, а
 * не тонут молча в `Map.set` (code-review-all, 2026-09-27, находка про недетерминизм).
 */
function resultTasks(resultsDir: string): { found: Map<string, string>; conflicts: string[] } {
  const found = new Map<string, string>();
  const wonAt = new Map<string, number>();
  const conflicts = new Set<string>();
  for (const name of readdirSync(resultsDir)) {
    if (!name.endsWith('.json')) continue;
    try {
      const value = readJson(join(resultsDir, name)) as { run?: { slug?: unknown; task?: unknown } };
      if (typeof value.run?.slug !== 'string' || typeof value.run.task !== 'string') continue;
      const { slug, task } = value.run;
      const mtime = statSync(join(resultsDir, name)).mtimeMs;
      const prevTask = found.get(slug);
      if (prevTask !== undefined && prevTask !== task) conflicts.add(slug);
      if (prevTask === undefined || mtime > (wonAt.get(slug) ?? -Infinity)) {
        found.set(slug, task);
        wonAt.set(slug, mtime);
      }
    } catch {
      // Повреждённый result будет назван причиной `result-not-found` у его обменов.
    }
  }
  return { found, conflicts: [...conflicts] };
}

function assistantMessage(raw: RawExchange): unknown | null {
  try {
    const response = JSON.parse(raw.response) as { choices?: Array<{ message?: unknown }> };
    return response.choices?.[0]?.message ?? null;
  } catch {
    return null;
  }
}

export function buildCorpus(args: {
  rawDir: string;
  resultsDir: string;
  heldOutTasks?: ReadonlySet<string>;
}): { examples: CorpusExample[]; report: CorpusReport } {
  const { found: taskBySlug, conflicts: slugTaskConflicts } = resultTasks(args.resultsDir);
  const heldOut = args.heldOutTasks ?? HELD_OUT_TASKS;
  const examples: CorpusExample[] = [];
  const report: CorpusReport = { scanned: 0, accepted: 0, rejected: {}, tasks: {}, modes: {}, slugTaskConflicts };

  for (const runName of readdirSync(args.rawDir, { withFileTypes: true })) {
    if (!runName.isDirectory()) continue;
    const runDir = join(args.rawDir, runName.name);
    for (const name of readdirSync(runDir)) {
      if (!name.endsWith('.json') || name.endsWith('.label.json')) continue;
      report.scanned++;
      const reject = (reason: string): void => bump(report.rejected, reason);
      let raw: RawExchange;
      let label: ExchangeLabel;
      try {
        raw = readJson(join(runDir, name)) as RawExchange;
      } catch {
        reject('invalid-exchange');
        continue;
      }
      // ДО чтения метки: обмен с плохим HTTP-статусом дампится (`OpenAiCompatProvider`
      // пишет дамп раньше проверки статуса), но `chat()` после этого бросает исключение —
      // ни один из трёх писателей меток (`FormFillExecutor`/`StepExecutor`/`claimFill`/
      // `reviewFill`/`planAxisFill`) не получает шанс вызвать `annotateExchange` для НЕГО.
      // Значит `.label.json` для такого обмена никогда не появится, и проверка статуса
      // ПОСЛЕ чтения метки была бы мёртвым кодом — `missing-label` перехватывал бы раньше
      // (code-review-all, 2026-09-27).
      if (!Number.isInteger(raw.status) || raw.status < 200 || raw.status >= 300) {
        reject('provider-error');
        continue;
      }
      try {
        label = readJson(join(runDir, `${name}.label.json`)) as ExchangeLabel;
      } catch {
        reject('missing-label');
        continue;
      }
      const task = taskBySlug.get(raw.slug);
      if (task === undefined) {
        reject('result-not-found');
        continue;
      }
      if (heldOut.has(task)) {
        reject('held-out-task');
        continue;
      }
      if (label.accepted !== true) {
        reject('oracle-rejected');
        continue;
      }
      if (!TRAINABLE_MODES.has(raw.mode)) {
        reject('unsupported-mode');
        continue;
      }
      if (!Array.isArray(raw.request?.messages)) {
        reject('invalid-request');
        continue;
      }
      const assistant = assistantMessage(raw);
      if (assistant === null) {
        reject('invalid-response');
        continue;
      }
      const source = `${runName.name}/${name}`;
      examples.push({
        messages: [...raw.request.messages, assistant],
        ...(raw.request.tools === undefined ? {} : { tools: raw.request.tools }),
        metadata: {
          slug: raw.slug,
          task,
          stage: raw.stage,
          mode: raw.mode,
          provider: raw.provider,
          model: raw.model,
          oracle: typeof label.oracle === 'string' ? label.oracle : 'unspecified',
          target: typeof label.target === 'string' ? label.target : raw.mode,
          source,
        },
      });
      report.accepted++;
      bump(report.tasks, task);
      bump(report.modes, raw.mode);
    }
  }
  return { examples, report };
}

export function writeCorpus(path: string, examples: readonly CorpusExample[]): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.tmp`;
  writeFileSync(temp, examples.map((x) => JSON.stringify(x)).join('\n') + (examples.length === 0 ? '' : '\n'), 'utf8');
  renameSync(temp, path);
}

function arg(name: string, fallback: string): string {
  const prefix = `--${name}=`;
  const value = process.argv.slice(2).find((x) => x.startsWith(prefix));
  return value === undefined ? fallback : resolve(value.slice(prefix.length));
}

const here = dirname(fileURLToPath(import.meta.url));
if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const benchDir = resolve(here, '..');
  const rawDir = arg('raw', join(benchDir, 'rawlogs'));
  const resultsDir = arg('results', join(benchDir, 'results'));
  const out = arg('out', join(benchDir, 'corpus', 'train.jsonl'));
  const built = buildCorpus({ rawDir, resultsDir });
  writeCorpus(out, built.examples);
  process.stdout.write(`${JSON.stringify({ output: out, ...built.report }, null, 2)}\n`);
}
