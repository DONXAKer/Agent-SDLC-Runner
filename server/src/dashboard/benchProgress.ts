/**
 * Идущие и незаконченные прогоны стенда — у них ещё нет `result.json` (стенд пишет его в
 * самом конце), и без этого модуля они на дашборде не видны вовсе.
 *
 * Главный источник — машинный `traces/<slug>/run-state.json` (контракт `BenchRunState`,
 * пишет `bench/src/runState.ts`): pid процесса, рабочая копия, отметки этапов, остановка и
 * «результат уже записан». Прогоны, запущенные до появления этого файла, читаются по
 * человекочитаемому `progress.log` — только как запасной путь: у лога нет контракта, путь
 * рабочей копии виден лишь в тексте сообщений рантайма, а «процесс жив» по нему выводится
 * из давности правки (`STALE_MS`), что ошибается в обе стороны.
 */

import { statSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';

import { BENCH_HEARTBEAT_MS, BENCH_RUN_STATE_FILE, DASHBOARD_BENCH_PROJECT, STAGE_ORDER } from '@sdlc-runner/shared';
import type { BenchRunState, DashboardCard, DashboardStage, HistoryStatus, StageId, Usage } from '@sdlc-runner/shared';

import { isStageId, stageById } from '../run/stages/index.ts';
import { readCapped } from './artifactAccess.ts';

/** Только для прогонов без `run-state.json`: лог без правок дольше этого — процесса нет. */
export const STALE_MS = 30 * 60_000;

/** Общий вид прогона без результата — из файла состояния либо из лога хода. */
export interface ProgressInfo {
  slug: string;
  model: string;
  task: string;
  startedAt: string;
  routes: Partial<Record<StageId, string>>;
  measured: StageId[];
  mode: { kind: 'all' } | { kind: 'stage'; stage: StageId } | null;
  /** Отметки этапов по порядку. */
  marks: { stage: StageId; kind: 'start' | 'ok' | 'fail'; note: string | null; chunk: number; attempt: number }[];
  /** Этап, с которого начал драйвер; `null` — не записан (лог), выводится из первой отметки. */
  startStage: StageId | null;
  /** Машина и пульс процесса; `null` — прогон без файла состояния. */
  host: string | null;
  heartbeatAt: string | null;
  /** Валюта маршрута каждого этапа. */
  currencies: Partial<Record<StageId, string>>;
  /** Остановка драйвера (`handoff`, `blocked`, …, `exception`); `null` — прогон не закончен. */
  stopped: string | null;
  /** Действие финального вердикта; `null` — вердикта нет или неизвестно. */
  verdict: string | null;
  /** Текст конца для человека (строка лога либо сообщение исключения). */
  endText: string | null;
  workspace: string | null;
  /** pid процесса стенда; `null` — прогон без файла состояния (только лог). */
  pid: number | null;
  resultWritten: boolean;
  snapshot: string | null;
}

// ── файл состояния ─────────────────────────────────────────────────────────

export function fromRunState(s: BenchRunState): ProgressInfo {
  return {
    slug: s.slug,
    model: s.model,
    task: s.task,
    startedAt: s.startedAt,
    routes: s.routes,
    measured: s.measured,
    mode: s.mode,
    marks: s.stages.map((m) => ({ stage: m.stage, kind: m.kind, note: m.note ?? null, chunk: m.chunk, attempt: m.attempt })),
    startStage: s.startStage ?? null,
    host: s.host ?? null,
    heartbeatAt: s.heartbeatAt ?? null,
    currencies: s.currencies ?? {},
    stopped: s.end?.stopped ?? null,
    verdict: s.end?.verdict ?? null,
    endText: s.end === null ? null : (s.end.message ?? `остановка: ${s.end.stopped}${s.end.verdict === null ? '' : ` · вердикт: ${s.end.verdict}`}`),
    workspace: s.workspace,
    pid: s.pid,
    resultWritten: s.resultWritten,
    snapshot: s.snapshot,
  };
}

function parseRunState(text: string): ProgressInfo | null {
  try {
    const s = JSON.parse(text) as Partial<BenchRunState>;
    if (s.version !== 1 || typeof s.slug !== 'string' || typeof s.pid !== 'number' || !Array.isArray(s.stages)) return null;
    // Поля, без которых разбор не имеет смысла, — дополняются: запись ранней версии стенда
    // (без `end`, `routes`) не должна ронять разбор и прятать прогон с дашборда.
    return fromRunState({ routes: {}, measured: [], end: null, resultWritten: false, snapshot: null, ...s } as BenchRunState);
  } catch {
    return null;
  }
}

// ── запасной путь: лог хода ────────────────────────────────────────────────

export function parseProgressLog(text: string): ProgressInfo | null {
  const lines = text.split(/\r?\n/);
  const head = /^# (\S+) · модель (\S+) · задача (\S+) · (\S+)$/.exec(lines[0] ?? '');
  if (head === null) return null;
  const routes: Partial<Record<StageId, string>> = {};
  const measured: StageId[] = [];
  const marks: ProgressInfo['marks'] = [];
  // Номер chunk'а и попытки у лога — из строки начала этапа «(chunk N, попытка K…»).
  let cur = { chunk: 1, attempt: 1 };
  let endText: string | null = null;
  let stopped: string | null = null;
  let verdict: string | null = null;
  let workspace: string | null = null;
  for (const line of lines.slice(1)) {
    const route = /^#\s+(\w+)\s+(\S+)(\s+\(под измерением\))?\s*$/.exec(line);
    if (route !== null && isStageId(route[1])) {
      routes[route[1]] = route[2] ?? '';
      if (route[3] !== undefined) measured.push(route[1]);
      continue;
    }
    const start = /^▶ \d\d:\d\d:\d\d (\w+) /.exec(line);
    if (start !== null && isStageId(start[1])) {
      const n = /\(chunk (\d+), попытка (\d+)/.exec(line);
      if (n !== null) cur = { chunk: Number(n[1]), attempt: Number(n[2]) };
      marks.push({ stage: start[1], kind: 'start', note: null, ...cur });
      continue;
    }
    const done = /^■ \d\d:\d\d:\d\d (\w+) (✅|❌)(.*)$/.exec(line);
    if (done !== null && isStageId(done[1])) {
      marks.push({ stage: done[1], kind: done[2] === '✅' ? 'ok' : 'fail', note: (done[3] ?? '').replace(/^\s*—\s*/, '') || null, ...cur });
      continue;
    }
    const fin = /^# \d\d:\d\d:\d\d ((остановка|исключение):\s*(.*))$/.exec(line);
    if (fin !== null) {
      endText = fin[1] ?? null;
      if (fin[2] === 'исключение') {
        stopped = 'exception';
      } else {
        const m = /^(\S+)(?: · вердикт: (\S+))?/.exec(fin[3] ?? '');
        stopped = m?.[1] ?? null;
        verdict = m?.[2] === undefined || m[2] === '—' ? null : m[2];
      }
      continue;
    }
    if (workspace === null) {
      const ws = /((?:[A-Za-z]:[\\/]|\/)[^\s"'`]*?sdlc-bench-[A-Za-z0-9._-]+)[\\/]\.sdlc[\\/]/.exec(line);
      if (ws !== null) workspace = ws[1] ?? null;
    }
  }
  return {
    slug: head[1] ?? '',
    model: head[2] ?? '',
    task: head[3] ?? '',
    startedAt: head[4] ?? '',
    routes,
    measured,
    mode: null,
    marks,
    startStage: null,
    host: null,
    heartbeatAt: null,
    currencies: {},
    stopped,
    verdict,
    endText,
    workspace,
    pid: null,
    resultWritten: false,
    snapshot: null,
  };
}

/** Лог хода читается целиком: выпавшая середина теряла отметки этапов. Больше потолка — не разбирается. */
const MAX_LOG_BYTES = 64 * 1024 * 1024;

// ── чтение с кэшем ─────────────────────────────────────────────────────────

/** Разборы файлов трасс по (mtime, размер). Предел — трасс сотни, а каталоги удаляются. */
const cache = new Map<string, { mtimeMs: number; size: number; info: ProgressInfo | null }>();
const CACHE_MAX = 2000;

function readParsed(path: string, parse: (text: string) => ProgressInfo | null): { info: ProgressInfo | null; mtimeMs: number } | null {
  let st: { mtimeMs: number; size: number };
  try {
    st = statSync(path);
  } catch {
    cache.delete(path);
    return null;
  }
  const hit = cache.get(path);
  if (hit !== undefined && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return { info: hit.info, mtimeMs: st.mtimeMs };
  let info: ProgressInfo | null = null;
  try {
    info = st.size > MAX_LOG_BYTES ? null : parse(readCapped(path, MAX_LOG_BYTES).text);
  } catch {
    info = null;
  }
  cache.delete(path);
  cache.set(path, { mtimeMs: st.mtimeMs, size: st.size, info });
  while (cache.size > CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
  return { info, mtimeMs: st.mtimeMs };
}

/**
 * Прогон по каталогу трассы: файл состояния, иначе лог хода. `null` — ни того ни другого.
 * Нечитаемый файл состояния (битый, будущая версия) не прячет прогон: берётся лог.
 * `mtimeMs` — время правки прочитанного файла (для запасного пути это и есть «признак жизни»).
 */
export function readRunProgress(traceDir: string): { info: ProgressInfo | null; mtimeMs: number } | null {
  const state = readParsed(join(traceDir, BENCH_RUN_STATE_FILE), parseRunState);
  if (state !== null && state.info !== null) return state;
  return readParsed(join(traceDir, 'progress.log'), parseProgressLog) ?? state;
}

/** Жив ли процесс: сигнал 0 ничего не шлёт, только проверяет существование. */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Пульс старше этого — процесса нет, какой бы pid ни был занят. */
const HEARTBEAT_STALE_MS = 3 * BENCH_HEARTBEAT_MS;

export interface LivenessProbe {
  pidAlive: (pid: number) => boolean;
  host: string;
}

const LOCAL: LivenessProbe = { pidAlive, host: hostname() };

/**
 * Жив ли процесс прогона. С файлом состояния — пульс свежий И (на этой машине) pid жив:
 * pid на Windows быстро переиспользуется, и убитый прогон, чей pid занял чужой процесс,
 * без пульса «шёл» бы вечно; на другой машине или в контейнере (чужое пространство pid)
 * pid ничего не значит — судит только пульс. Без файла состояния — давность правки лога.
 */
export function processAlive(info: ProgressInfo, mtimeMs: number, now: number, probe: LivenessProbe = LOCAL): boolean {
  if (info.pid === null) return now - mtimeMs < STALE_MS;
  const beat = info.heartbeatAt === null ? Number.NaN : Date.parse(info.heartbeatAt);
  const fresh = Number.isNaN(beat) ? now - mtimeMs < HEARTBEAT_STALE_MS : now - beat < HEARTBEAT_STALE_MS;
  if (!fresh) return false;
  return info.host !== null && info.host !== probe.host ? true : probe.pidAlive(info.pid);
}

// ── исход ──────────────────────────────────────────────────────────────────

export interface ProgressOutcome {
  running: boolean;
  status: HistoryStatus;
  /** Что показать в строке «стоп». */
  stopped: string;
}

function finishedStatus(info: ProgressInfo): HistoryStatus {
  if (info.snapshot !== null || info.stopped === 'snapshot-point') return 'unfinished';
  // `verify-measured` — тот же смысл, что `handoff`: измерение состоялось, зелёный вердикт
  // (`continue`) читается как «передан» (см. `dashboard/bench.ts::benchStatus`, синхронная
  // правка тем же коммитом — до неё живая панель показывала «оборван» на успешном
  // `--stage verify` без `--make-snapshot`, code-review-all 2026-09-28).
  if ((info.stopped === 'handoff' || info.stopped === 'verify-measured') && info.verdict === 'continue') return 'done';
  return 'aborted';
}

/**
 * Исход прогона без результата. Остановка записана, а результата ещё нет — прогон
 * дописывает итоги (скрытые тесты, отчёт), это не обрыв; снимок (`--make-snapshot`)
 * результата не пишет никогда.
 */
export function progressOutcome(info: ProgressInfo, mtimeMs: number, now: number, probe: LivenessProbe = LOCAL): ProgressOutcome {
  const live = processAlive(info, mtimeMs, now, probe);
  if (info.stopped === null) {
    return live
      ? { running: true, status: 'open', stopped: 'идёт' }
      : { running: false, status: 'aborted', stopped: 'оборван: процесса нет, конец прогона не записан' };
  }
  if (info.snapshot !== null) return { running: false, status: 'unfinished', stopped: `снимок «${info.snapshot}» сохранён` };
  if (live) return { running: true, status: 'open', stopped: `дописывает итоги: ${info.endText ?? info.stopped}` };
  return { running: false, status: finishedStatus(info), stopped: `${info.endText ?? info.stopped} · result.json не записан` };
}

/** Этап, идущий сейчас: последний начатый и не закрытый. */
export function runningStage(info: ProgressInfo): StageId | null {
  const open = new Set<StageId>();
  let last: StageId | null = null;
  for (const m of info.marks) {
    if (m.kind === 'start') {
      open.add(m.stage);
      last = m.stage;
    } else {
      open.delete(m.stage);
    }
  }
  return last !== null && open.has(last) ? last : null;
}

function modeOf(info: ProgressInfo): { kind: 'all' } | { kind: 'stage'; stage: StageId } {
  if (info.mode !== null) return info.mode;
  const first = info.marks.find((m) => m.kind === 'start')?.stage;
  return first !== undefined && first !== 'intent' ? { kind: 'stage', stage: first } : { kind: 'all' };
}

/**
 * Этап, с которого начал драйвер. Записан стендом — берётся он: снимок «после intent» при
 * замере chunk начинает с explore, и режим прогона об этом не говорит. Не записан (лог) —
 * первая отметка начала.
 */
function startOf(info: ProgressInfo): StageId {
  if (info.startStage !== null) return info.startStage;
  return info.marks.find((m) => m.kind === 'start')?.stage ?? 'intent';
}

/**
 * Этапы по отметкам — когда рабочей копии нет (удалена или не найдена). Этапы до этапа
 * старта драйвера пройдены «из снимка».
 */
export function progressStages(info: ProgressInfo, running: boolean): DashboardStage[] {
  const firstIdx = STAGE_ORDER.indexOf(startOf(info));
  const now = running ? runningStage(info) : null;
  return STAGE_ORDER.map((id, idx) => {
    const own = info.marks.filter((m) => m.stage === id);
    const last = own[own.length - 1];
    const base = { id, title: stageById(id).title, blamed: null, outputs: [] };
    if (last === undefined) {
      return idx < firstIdx ? { ...base, state: 'done' as const, note: 'из снимка' } : { ...base, state: 'notStarted' as const, note: null };
    }
    if (last.kind === 'ok') return { ...base, state: 'done' as const, note: null };
    if (last.kind === 'fail') return { ...base, state: 'failed' as const, note: last.note };
    return id === now
      ? { ...base, state: 'running' as const, note: 'выполняется' }
      : { ...base, state: 'failed' as const, note: 'прогон оборван: этап начат, но не закрыт' };
  });
}

/** Карточка прогона без результата; `base` — карточка по живой рабочей копии, если она есть. */
export function progressCard(
  info: ProgressInfo,
  outcome: ProgressOutcome,
  opts: {
    slug: string;
    /** Проект индекса стенда (`results`/`archive`); не задан — рабочий каталог. */
    project?: string;
    mtimeMs: number;
    base: DashboardCard | null;
    /** Расход по валютам маршрутов (у рабочей копии стенда `spent` сужен до измеряемых этапов). */
    cost?: { usage: Usage | null; currency: string | undefined };
  },
): DashboardCard {
  const stages = opts.base?.stages ?? progressStages(info, outcome.running);
  const updated = Math.max(opts.mtimeMs, opts.base === null ? 0 : Date.parse(opts.base.updatedAt) || 0);
  // Номер chunk'а и попытки без рабочей копии — из последней отметки этапа.
  const lastMark = info.marks[info.marks.length - 1];
  const usage = opts.cost?.usage ?? opts.base?.usage ?? null;
  const currency = opts.cost !== undefined ? opts.cost.currency : opts.base?.currency;
  return {
    ref: { source: 'bench', project: opts.project ?? DASHBOARD_BENCH_PROJECT, slug: opts.slug },
    status: outcome.status,
    updatedAt: new Date(updated).toISOString(),
    chunk: opts.base?.chunk ?? lastMark?.chunk ?? 1,
    attempt: opts.base?.attempt ?? lastMark?.attempt ?? 1,
    stages,
    usage,
    ...(currency === undefined ? {} : { currency }),
    live: null,
    bench: {
      model: info.model,
      task: info.task,
      mode: modeOf(info),
      routes: info.routes,
      stopped: outcome.stopped,
      finalVerdict: null,
      startedAt: info.startedAt,
      finishedAt: '',
      hasTrace: false,
      hasReport: false,
      inProgress: outcome.running,
    },
    runCount: opts.base?.runCount ?? 1,
  };
}
