/**
 * Прогоны стенда (`npm run bench`) для дашборда: `bench/results/<slug>.json`.
 *
 * Свой узкий разбор, а не импорт `bench/src/result.ts`: стенд сам импортирует сервер
 * (кольцо слоёв), и в образе каталога `bench/` может не быть вовсе. Отсюда и снисходительность:
 * старые результаты без поздних полей читаются, битые — пропускаются со счётчиком, а не
 * роняют список.
 *
 * Файлов сотни (22 МБ JSON), поэтому индекс держит только КАРТОЧКУ каждого файла под
 * ключом (mtime, размер): новый или изменённый файл разбирается один раз, неизменный — не
 * читается вовсе. Полный результат разбирается заново только для детальной карточки.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { BENCH_RUN_STATE_FILE, DASHBOARD_BENCH_PROJECT, STAGE_ORDER } from '@sdlc-runner/shared';
import type { DashboardCard, HistoryStatus, RunMetrics, StageId, Verdict } from '@sdlc-runner/shared';

import { normalizeMetrics, usageByCurrency } from '../run/metricsSnapshot.ts';
import { isStageId as isStage, stageById } from '../run/stages/index.ts';
import { progressOutcome, readRunProgress } from './benchProgress.ts';
import type { ProgressInfo, ProgressOutcome } from './benchProgress.ts';
import { benchStage } from './stageState.ts';
import type { BenchMode, BenchStageRecord } from './stageState.ts';

/** Прогон стенда без результата: идущий либо убитый. */
export interface ProgressRun {
  slug: string;
  info: ProgressInfo;
  mtimeMs: number;
  outcome: ProgressOutcome;
  /** Корень живой рабочей копии, если каталог витка в ней есть. */
  workspace: string | null;
}

export interface BenchResultLite {
  run: {
    slug: string;
    model: string;
    task: string;
    mode: BenchMode;
    routes: Partial<Record<StageId, string>>;
    currencies: Partial<Record<StageId, string>>;
    startedAt: string;
    finishedAt: string;
  };
  driver: { stages: BenchStageRecord[]; finalVerdict: Verdict | null; stopped: string };
  metrics: RunMetrics;
}

const obj = (v: unknown): Record<string, unknown> | null =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

function strRecord(v: unknown): Partial<Record<StageId, string>> {
  const o = obj(v);
  const out: Partial<Record<StageId, string>> = {};
  if (o === null) return out;
  for (const [k, val] of Object.entries(o)) if (isStage(k) && typeof val === 'string') out[k] = val;
  return out;
}

function verdictOf(v: unknown): Verdict | null {
  const o = obj(v);
  if (o === null || typeof o['passed'] !== 'boolean' || typeof o['action'] !== 'string') return null;
  return {
    passed: o['passed'],
    action: o['action'] as Verdict['action'],
    reasons: Array.isArray(o['reasons']) ? o['reasons'].filter((x): x is string => typeof x === 'string') : [],
  };
}

function recordOf(v: unknown): BenchStageRecord | null {
  const o = obj(v);
  if (o === null || !isStage(o['stage'])) return null;
  const num = (x: unknown): number | undefined => (typeof x === 'number' && Number.isFinite(x) ? x : undefined);
  const turns = num(o['turns']);
  const modelRequests = num(o['modelRequests']);
  const envFailure = typeof o['envFailure'] === 'string' ? o['envFailure'] : undefined;
  const blamedStage = isStage(o['blamedStage']) ? o['blamedStage'] : undefined;
  return {
    stage: o['stage'],
    chunk: num(o['chunk']) ?? 1,
    attempt: num(o['attempt']) ?? 1,
    ok: o['ok'] === true,
    note: str(o['note']),
    blockers: Array.isArray(o['blockers']) ? o['blockers'].filter((x): x is string => typeof x === 'string') : [],
    timedOut: o['timedOut'] === true,
    skipped: o['skipped'] === true,
    ...(envFailure === undefined ? {} : { envFailure }),
    ...(blamedStage === undefined ? {} : { blamedStage }),
    ...(turns === undefined ? {} : { turns }),
    ...(modelRequests === undefined ? {} : { modelRequests }),
    ...(o['closedBy'] === 'runtime' ? { closedBy: 'runtime' as const } : {}),
  };
}

/** Результат стенда либо `null`: не объект результата (сводка серии, чужой JSON). */
export function parseBenchResult(v: unknown): BenchResultLite | null {
  const o = obj(v);
  const run = obj(o?.['run']);
  const driver = obj(o?.['driver']);
  if (o === null || run === null || driver === null || !Array.isArray(driver['stages'])) return null;
  if (typeof run['slug'] !== 'string' || typeof run['model'] !== 'string') return null;
  const modeObj = obj(run['mode']);
  const mode: BenchMode =
    modeObj?.['kind'] === 'stage' && isStage(modeObj['stage']) ? { kind: 'stage', stage: modeObj['stage'] } : { kind: 'all' };
  return {
    run: {
      slug: run['slug'],
      model: run['model'],
      task: str(run['task']),
      mode,
      routes: strRecord(run['routes']),
      currencies: strRecord(run['currencies']),
      startedAt: str(run['startedAt']),
      finishedAt: str(run['finishedAt']),
    },
    driver: {
      stages: driver['stages'].map(recordOf).filter((r): r is BenchStageRecord => r !== null),
      finalVerdict: verdictOf(driver['finalVerdict'] ?? o['finalVerdict']),
      stopped: str(driver['stopped']),
    },
    metrics: normalizeMetrics(o['metrics']),
  };
}

/**
 * Статус прогона словарём статусов витка: дошёл до передачи с зелёным вердиктом — передан;
 * остановился в точке снимка намеренно — без записи о передаче; всё прочее (блокер,
 * таймаут, escalate, исчерпанные попытки) — оборван.
 */
export function benchStatus(r: BenchResultLite): HistoryStatus {
  if (r.driver.stopped === 'handoff') return r.driver.finalVerdict?.passed === true ? 'done' : 'aborted';
  if (r.driver.stopped === 'snapshot-point') return 'unfinished';
  return 'aborted';
}

function isoOr(v: string, fallbackMs: number): string {
  const t = Date.parse(v);
  return Number.isNaN(t) ? new Date(fallbackMs).toISOString() : new Date(t).toISOString();
}

export function benchCard(
  r: BenchResultLite,
  facts: { mtimeMs: number; hasTrace: boolean; hasReport: boolean; project?: string },
): DashboardCard {
  // Валюта — у этапов, которые реально тратили (общее правило `usageByCurrency`).
  const { usage, currency } = usageByCurrency(r.metrics.stages, (s) => r.run.currencies[s]);
  const lastRec = r.driver.stages[r.driver.stages.length - 1];
  return {
    ref: { source: 'bench', project: facts.project ?? DASHBOARD_BENCH_PROJECT, slug: r.run.slug },
    status: benchStatus(r),
    updatedAt: isoOr(r.run.finishedAt, facts.mtimeMs),
    chunk: lastRec?.chunk ?? 1,
    attempt: lastRec?.attempt ?? 1,
    stages: STAGE_ORDER.map((id) => {
      const s = benchStage(r.driver.stages, r.run.mode, id);
      return { id, title: stageById(id).title, state: s.state, blamed: s.blamed, note: s.note, outputs: [] };
    }),
    usage,
    ...(currency === undefined ? {} : { currency }),
    live: null,
    bench: {
      model: r.run.model,
      task: r.run.task,
      mode: r.run.mode,
      routes: r.run.routes,
      stopped: r.driver.stopped,
      finalVerdict: r.driver.finalVerdict,
      startedAt: r.run.startedAt,
      finishedAt: r.run.finishedAt,
      hasTrace: facts.hasTrace,
      hasReport: facts.hasReport,
      inProgress: false,
    },
    runCount: 1,
  };
}

function mtimeOrZero(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}

/** Каталог стенда по умолчанию — `bench/` рядом с сервером (`server/src/dashboard` → корень). */
export function defaultBenchDir(): string {
  return join(import.meta.dirname, '..', '..', '..', 'bench');
}

/** Не чаще этого пересматривать каталог результатов: опрос идёт с каждой открытой вкладки. */
const REFRESH_MS = 3000;
/** Полный пересмотр каталогов стенда — не чаще этого. */
const FULL_SCAN_MS = 30_000;

export class BenchIndex {
  private readonly entries = new Map<string, { mtimeMs: number; size: number; card: DashboardCard | null }>();
  private refreshedAt = 0;
  private readonly progressRuns = new Map<string, ProgressRun>();
  /** Что лежит в каталоге трассы: ничего, законченный прогон (с временем его результата) или прогон без результата. */
  private readonly traceKind = new Map<string, { kind: 'none' | 'finished' | 'progress'; resultMtime: number | null; traceMtime: number }>();
  private resultsDirMtime = -1;
  private fullScanAt = 0;
  readonly dir: string;
  /** Проект карточек в адресе: `results` у рабочего каталога, `archive` у архива стенда. */
  readonly project: string;

  constructor(dir: string, project: string = DASHBOARD_BENCH_PROJECT) {
    this.dir = dir;
    this.project = project;
  }

  get resultsDir(): string {
    return join(this.dir, 'results');
  }

  /** Стенд на этой машине есть: каталог результатов или трасс (первый прогон пишет трассу раньше результата). */
  available(): boolean {
    for (const d of [this.resultsDir, join(this.dir, 'traces')]) {
      try {
        if (statSync(d).isDirectory()) return true;
      } catch {
        /* нет каталога */
      }
    }
    return false;
  }

  resultPath(slug: string): string {
    return join(this.resultsDir, `${slug}.json`);
  }

  reportPath(slug: string): string {
    return join(this.resultsDir, `${slug}.report.md`);
  }

  tracePath(slug: string): string {
    return join(this.dir, 'traces', slug, 'events.ndjson');
  }

  progressPath(slug: string): string {
    return join(this.dir, 'traces', slug, 'progress.log');
  }

  private statResult(slug: string): void {
    let st: { mtimeMs: number; size: number };
    try {
      st = statSync(this.resultPath(slug));
    } catch {
      this.entries.delete(slug);
      return;
    }
    const hit = this.entries.get(slug);
    if (hit !== undefined && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return;
    const r = this.load(slug);
    const card =
      r === null
        ? null
        : benchCard(
            // Слаг адреса — имя файла, а не поле внутри: переименованный файл иначе
            // открывался бы по имени, которого в каталоге нет.
            { ...r, run: { ...r.run, slug } },
            {
              mtimeMs: st.mtimeMs,
              hasTrace: existsSync(this.tracePath(slug)),
              hasReport: existsSync(this.reportPath(slug)),
              project: this.project,
            },
          );
    this.entries.set(slug, { mtimeMs: st.mtimeMs, size: st.size, card });
  }

  /**
   * Пересмотр каталогов. Файлов сотни, и `stat` каждого на каждый опрос держал цикл событий
   * десятки миллисекунд, поэтому быстрый проход (раз в `REFRESH_MS`) смотрит только новые
   * имена и прогоны без результата, а полный — всё — раз в `FULL_SCAN_MS` или по `force`.
   */
  refresh(now: number = Date.now(), force = false): void {
    if (!force && now - this.refreshedAt < REFRESH_MS) return;
    this.refreshedAt = now;
    const full = force || now - this.fullScanAt >= FULL_SCAN_MS;
    if (full) this.fullScanAt = now;
    // Стенд пишет результат через временный файл и переименование — это меняет время правки
    // каталога `results/`. Изменился каталог — пересматриваются все результаты: иначе
    // переписанный на месте результат (перезапуск, пересчёт) до полного прохода был бы старым.
    const dirMtime = mtimeOrZero(this.resultsDir);
    const resultsChanged = dirMtime !== this.resultsDirMtime;
    this.resultsDirMtime = dirMtime;
    let files: string[] = [];
    try {
      files = readdirSync(this.resultsDir);
    } catch {
      files = [];
    }
    const seen = new Set<string>();
    for (const f of files) {
      // Только `<slug>.json`: рядом лежат `<slug>.report.md` и логи серий.
      if (!f.endsWith('.json')) continue;
      const slug = f.slice(0, -'.json'.length);
      seen.add(slug);
      // Результат перезапущенного слага переписывается на месте — его ловит прогон без
      // результата, который отслеживается на каждом проходе.
      if (full || resultsChanged || !this.entries.has(slug) || this.progressRuns.has(slug)) this.statResult(slug);
    }
    for (const slug of [...this.entries.keys()]) if (!seen.has(slug)) this.entries.delete(slug);
    // Прогоны без результата пересматриваются и при пустом/отсутствующем `results/`: первый
    // прогон на машине пишет трассу задолго до результата.
    this.refreshProgress(now, full);
  }

  /**
   * Прогоны без свежего результата — по трассе (`benchProgress.ts`): идущие и незаконченные.
   * Трасса, результат которой свежее её старта, — законченный прогон; такие и трассы без
   * файлов хода между полными проходами не перечитываются.
   */
  private refreshProgress(now: number, full: boolean): void {
    const traces = join(this.dir, 'traces');
    let dirs: string[];
    try {
      dirs = readdirSync(traces);
    } catch {
      this.progressRuns.clear();
      this.traceKind.clear();
      return;
    }
    const present = new Set(dirs);
    for (const slug of dirs) {
      // `traces/raw` — сырой дамп запросов к модели, не прогон.
      if (slug === 'raw') continue;
      const known = this.traceKind.get(slug);
      const result = this.entries.get(slug);
      // Время правки каталога трассы: перезапуск слага первым делом пишет файл состояния
      // через временный файл и переименование — каталог меняется, и законченный прогон
      // пересматривается сразу, а не через полный проход.
      const traceMtime = mtimeOrZero(join(traces, slug));
      if (!full && known !== undefined && known.traceMtime === traceMtime) {
        if (known.kind === 'none') continue;
        if (known.kind === 'finished' && known.resultMtime === (result?.mtimeMs ?? null)) continue;
      }
      // Старый прогон без файла состояния, чей результат записан позже последней строки лога,
      // закончен — определяется по времени правки, без чтения лога в мегабайты.
      if (result !== undefined && !existsSync(join(traces, slug, BENCH_RUN_STATE_FILE))) {
        let logMtime = 0;
        try {
          logMtime = statSync(join(traces, slug, 'progress.log')).mtimeMs;
        } catch {
          /* лога нет */
        }
        if (logMtime > 0 && result.mtimeMs >= logMtime) {
          this.traceKind.set(slug, { kind: 'finished', resultMtime: result.mtimeMs, traceMtime });
          this.progressRuns.delete(slug);
          continue;
        }
      }
      const p = readRunProgress(join(traces, slug));
      if (p === null || p.info === null) {
        this.traceKind.set(slug, { kind: 'none', resultMtime: null, traceMtime });
        this.progressRuns.delete(slug);
        continue;
      }
      const started = Date.parse(p.info.startedAt);
      const fresh = result !== undefined && (p.info.resultWritten || (!Number.isNaN(started) && result.mtimeMs >= started));
      if (fresh) {
        this.traceKind.set(slug, { kind: 'finished', resultMtime: result.mtimeMs, traceMtime });
        this.progressRuns.delete(slug);
        continue;
      }
      this.traceKind.set(slug, { kind: 'progress', resultMtime: result?.mtimeMs ?? null, traceMtime });
      const outcome = progressOutcome(p.info, p.mtimeMs, now);
      const ws = p.info.workspace;
      const workspace = ws !== null && existsSync(join(ws, '.sdlc', slug)) ? ws : null;
      this.progressRuns.set(slug, { slug, info: p.info, mtimeMs: p.mtimeMs, outcome, workspace });
    }
    for (const slug of [...this.progressRuns.keys()]) if (!present.has(slug)) this.progressRuns.delete(slug);
    for (const slug of [...this.traceKind.keys()]) if (!present.has(slug)) this.traceKind.delete(slug);
  }

  /** Идущие и незаконченные прогоны (без результата). */
  progress(): ProgressRun[] {
    this.refresh();
    return [...this.progressRuns.values()];
  }

  progressRun(slug: string): ProgressRun | null {
    this.refresh();
    return this.progressRuns.get(slug) ?? null;
  }

  list(now?: number): { cards: DashboardCard[]; skipped: number; available: boolean } {
    if (!this.available()) return { cards: [], skipped: 0, available: false };
    this.refresh(now);
    const cards: DashboardCard[] = [];
    let skipped = 0;
    for (const [slug, e] of this.entries) {
      if (e.card === null) skipped += 1;
      // Слаг перезапущен и идёт заново — старый результат уступает карточку идущему.
      else if (!this.progressRuns.has(slug)) cards.push(e.card);
    }
    return { cards, skipped, available: true };
  }

  /** Слаг известен индексу — единственный способ адресовать файл стенда снаружи. */
  has(slug: string): boolean {
    this.refresh();
    return this.entries.get(slug)?.card != null || this.progressRuns.has(slug);
  }

  card(slug: string): DashboardCard | null {
    this.refresh();
    return this.entries.get(slug)?.card ?? null;
  }

  /** Полный результат прогона — заново с диска (в индексе держится только карточка). */
  load(slug: string): BenchResultLite | null {
    try {
      return parseBenchResult(JSON.parse(readFileSync(this.resultPath(slug), 'utf8')));
    } catch {
      return null;
    }
  }
}
