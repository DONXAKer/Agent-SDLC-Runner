/**
 * Карточки витков на диске — раннера и терминальных скиллов `/sdlc-*`.
 *
 * Только чтение: `Run` здесь не поднимается никогда (его конструктор пишет
 * `.runner/.gitignore` в каталог витка, а дашборд обязан не менять ничего). Номер chunk'а и
 * попытки восстанавливаются тем же приёмом, что у `Run` (журналы на диске), состояние
 * этапов — теми же функциями, что у страницы живого витка (`run/stageInfo.ts`,
 * `stages/entry.ts`, `stages/preconditions.ts::artifactPlaceholders`), чтобы две
 * поверхности не разошлись в том, что «пройдено».
 *
 * Опрос идёт раз в пять секунд по всем проектам, поэтому:
 * - дисковая часть карточки кэшируется по подписи каталога витка, и подпись считается ДО
 *   любого чтения содержимого; лента в подпись не входит — её сводка дочитывается по
 *   смещению отдельно (`events.ts::readEventSummary`), иначе живой виток пересчитывался бы
 *   целиком на каждой записи ленты;
 * - давно не менявшийся архивный виток сверяет подпись не чаще `ARCHIVE_RECHECK_MS`;
 * - собранная карточка переиспользуется, пока не изменились её входы, — неизменная карточка
 *   остаётся тем же объектом, и ответ списка не сериализует её заново;
 * - кэш ограничен: рабочие копии стенда (`%TEMP%/sdlc-bench-*`) приходят и уходят.
 */

import type { Dirent } from 'node:fs';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { addUsage, emptyUsage } from '@sdlc-runner/shared';
import type {
  DashboardArtifact,
  DashboardCard,
  DashboardProjectRef,
  DashboardSource,
  HistoryStatus,
  RunSummary,
  StageId,
  Usage,
} from '@sdlc-runner/shared';

import { RUNNER_DIR, SDLC_DIR, WitokPaths } from '../artifacts/paths.ts';
import { readGatesCached } from '../gates/gatesCache.ts';
import { requirementExcerpt, statusOf } from '../history.ts';
import { normalizeMetrics, readMetricsRaw } from '../run/metricsSnapshot.ts';
import { decisionArtifactPath, decisionState } from '../run/stageInfo.ts';
import { chunkFromNames, restoreAttemptFromJournal } from '../run/stages/chunk/restore.ts';
import { entryProblems } from '../run/stages/entry.ts';
import type { EntryProblem } from '../run/stages/entry.ts';
import { STAGES } from '../run/stages/index.ts';
import { artifactPlaceholders } from '../run/stages/preconditions.ts';
import type { StageContext, StageDef } from '../run/stages/types.ts';
import { verdictPath } from '../run/verdictStore.ts';
import { artifactStatus, relName } from './artifacts.ts';
import { readEventSummary } from './events.ts';
import type { EventSummary } from './events.ts';
import { resolveStages } from './stageState.ts';
import type { StageFacts } from './stageState.ts';

/** Архивный виток, не менявшийся дольше этого, сверяет подпись реже. */
const ARCHIVE_AGE_MS = 10 * 60_000;
const ARCHIVE_RECHECK_MS = 60_000;
/**
 * Блокеры входа зависят не только от каталога витка: вход ask и plan проверяет, что пути
 * карты разведки существуют в ДЕРЕВЕ ПРОЕКТА (`explorationPathsExist`). Их подпись не
 * ловит, поэтому блокеры пересчитываются не реже этого.
 */
const BLOCKERS_TTL_MS = 30_000;
/** Предел кэша: витков всех проектов плюс рабочих копий стенда больше не бывает. */
const FACTS_MAX = 2000;

/**
 * Источник витка. Признак косвенный: `ui` — этапы витка запускал раннер (в ленте есть
 * прогоны этапов, есть числа витка) либо виток живой. Сам каталог `.runner/` признаком не
 * служит: его создаёт конструктор `Run` при простом открытии витка, и терминальный виток,
 * однажды открытый в интерфейсе, навсегда становился «ui».
 */
function witokSource(files: readonly string[], runnerFiles: readonly string[], events: EventSummary, live: RunSummary | null): Exclude<DashboardSource, 'bench'> {
  if (live !== null) return 'ui';
  if (events.stagesRun > 0 || runnerFiles.includes('metrics.json') || files.includes('metrics.json')) return 'ui';
  return 'terminal';
}

/**
 * Статус файла витка для дашборда. Полнота задачи (`intent.md`) и готовности
 * (`readiness.md`) — той же функцией, что страж соответствующего этапа
 * (`artifactPlaceholders`): секция «Что придётся тронуть» законно пуста до разведки,
 * «Прогон 2» готовности — до плана, и вход этапа, выход этапа и просмотрщик обязаны
 * считать это одинаково. `stageId` — чей это артефакт (для `readiness.md` отличает
 * «Прогон 1» intent'а от «Прогон 2» plan'а); без него — счёт по всему файлу, как у общего
 * списка артефактов без привязки к этапу.
 */
export function witokArtifactStatus(
  ctx: StageContext,
  abs: string,
  opts: { optional?: boolean; decision?: DashboardArtifact['decision']; stageId?: StageId } = {},
): DashboardArtifact {
  const { stageId, ...rest } = opts;
  const override =
    abs === ctx.paths.intent || abs === ctx.paths.readiness ? { placeholders: artifactPlaceholders(abs, ctx, stageId).placeholders } : {};
  return artifactStatus(ctx.paths, abs, { ...rest, ...override });
}

/**
 * Что этап оставил на диске: `produces` плюс улики попытки из хука этапа (`StageDef.evidence`)
 * — только существующие: их отсутствие этап не роняет.
 */
function stageOutputs(def: StageDef, ctx: StageContext, required: readonly string[], exists: (p: string) => boolean): DashboardArtifact[] {
  const extra = (def.evidence?.(ctx) ?? []).filter((x) => !required.includes(x) && exists(x));
  const decisionPath = decisionArtifactPath(def, ctx);
  return [...required, ...extra].map((abs) => {
    const decision =
      abs === decisionPath && def.humanGate !== null
        ? (() => {
            const st = decisionState(def, ctx);
            return st === null ? null : { label: def.humanGate.label, state: st };
          })()
        : null;
    return witokArtifactStatus(ctx, abs, { decision, stageId: def.id });
  });
}

/**
 * Сумма расхода по этапам снапшота и её валюта. Валюта витка — из сумм по валютам
 * (`spent`), и только тех, что реально тратились: рубли с долларами в одну сумму не
 * складываются, у смешанного расхода стоимость не называется.
 */
function usageFromMetrics(paths: WitokPaths): { usage: Usage | null; currency: string | undefined } {
  const r = readMetricsRaw(paths);
  if (r === null) return { usage: null, currency: undefined };
  const m = normalizeMetrics(r.raw);
  let usage = emptyUsage();
  for (const s of m.stages) usage = addUsage(usage, s.usage);
  const currencies = r.spent === null ? [] : Object.entries(r.spent).filter(([, v]) => typeof v === 'number' && v > 0).map(([k]) => k);
  if (currencies.length > 1) return { usage: { ...usage, costUsd: null }, currency: undefined };
  return { usage, currency: currencies[0] };
}

export interface DiskFacts {
  signature: string;
  checkedAt: number;
  maxMtime: number;
  files: string[];
  runnerFiles: string[];
  ctx: StageContext;
  updatedAt: string;
  requirement: string | undefined;
  status: HistoryStatus;
  usage: Usage | null;
  currency: string | undefined;
  stages: { def: StageDef; produced: boolean; skipReason: string | null; outputs: DashboardArtifact[] }[];
  /** Блокеры входа по этапу (`<этап>` или `<этап>:abort`) и время их расчёта. */
  blockers: Map<string, { at: number; problems: EntryProblem[] }>;
  /** Последняя собранная карточка и ключ её входов. */
  card: { key: string; card: DashboardCard } | null;
}

const factsCache = new Map<string, DiskFacts>();

function mtimeOf(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}

function listDir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

/** Лента в подпись не входит: её сводка дочитывается отдельно, по смещению. */
const EVENTS_FILE = '.events.ndjson';

/**
 * Подпись каталога — только `readdir` и `stat`, без чтения содержимого: имена и время правки
 * файлов витка и `.runner/`, набор гейтов, живые номера.
 */
function signatureOf(paths: WitokPaths, files: readonly string[], runnerFiles: readonly string[], live: RunSummary | null): { sig: string; maxMtime: number } {
  let max = 0;
  const parts: string[] = [];
  const add = (name: string, abs: string): void => {
    const t = mtimeOf(abs);
    if (t > max) max = t;
    parts.push(`${name}@${t}`);
  };
  for (const f of files) if (f !== EVENTS_FILE) add(f, join(paths.dir, f));
  for (const f of runnerFiles) add(`${RUNNER_DIR}/${f}`, join(paths.runnerDir, f));
  const liveKey = live === null ? '-' : `${live.chunk}/${live.attempt}`;
  return { sig: [liveKey, parts.join('|'), mtimeOf(paths.gates)].join('#'), maxMtime: max };
}

function remember(key: string, facts: DiskFacts): void {
  factsCache.delete(key);
  factsCache.set(key, facts);
  while (factsCache.size > FACTS_MAX) {
    const oldest = factsCache.keys().next().value;
    if (oldest === undefined) break;
    factsCache.delete(oldest);
  }
}

function diskFacts(paths: WitokPaths, live: RunSummary | null, now: number): DiskFacts | null {
  const hit = factsCache.get(paths.dir);
  // Давно не менявшийся архивный виток — подпись сверяется не на каждом опросе: сотни
  // витков по двадцать файлов давали тысячи синхронных `stat` на каждый запрос списка.
  if (hit !== undefined && live === null && now - hit.maxMtime > ARCHIVE_AGE_MS && now - hit.checkedAt < ARCHIVE_RECHECK_MS) {
    remember(paths.dir, hit);
    return hit;
  }
  const files = listDir(paths.dir);
  if (files.length === 0 && live === null) {
    factsCache.delete(paths.dir);
    return null;
  }
  const runnerFiles = files.includes(RUNNER_DIR) ? listDir(paths.runnerDir) : [];
  const { sig, maxMtime } = signatureOf(paths, files, runnerFiles, live);
  if (hit !== undefined && hit.signature === `${sig}#${mtimeOf(verdictPath(paths, hit.ctx.chunk, hit.ctx.attempt))}`) {
    hit.checkedAt = now;
    remember(paths.dir, hit);
    return hit;
  }

  // chunk/попытка: у живого — из памяти, у архивного — из журналов, как у `Run`.
  const chunk = live?.chunk ?? chunkFromNames(files) ?? 1;
  const attempt = live?.attempt ?? restoreAttemptFromJournal(paths.chunkJournal(chunk)) ?? 1;
  const ctx: StageContext = { paths, chunk, attempt };
  const { usage, currency } = usageFromMetrics(paths);
  const exists = (p: string): boolean => mtimeOf(p) > 0;
  const facts: DiskFacts = {
    signature: `${sig}#${mtimeOf(verdictPath(paths, chunk, attempt))}`,
    checkedAt: now,
    maxMtime,
    files,
    runnerFiles,
    ctx,
    // Живой виток без единого файла — момент первой сборки, а не «сейчас» на каждом опросе:
    // иначе карточка менялась бы каждый тик и список никогда не отдавался бы ответом 304.
    updatedAt: new Date(maxMtime > 0 ? maxMtime : now).toISOString(),
    requirement: requirementExcerpt(paths),
    status: statusOf(paths, false),
    usage,
    currency,
    stages: STAGES.map((def) => {
      const required = def.produces(ctx);
      const outputs = stageOutputs(def, ctx, required, exists);
      const names = new Set(required.map((p) => relName(paths, p)));
      const own = outputs.filter((a) => names.has(a.name));
      return {
        def,
        // Пройденность — из уже посчитанных выходов тем же правилом, что `artifactProduced`:
        // все обязательные есть и без `‹…›` (у задачи — без законно пустой секции).
        produced: own.length > 0 && own.every((a) => a.presence === 'filled'),
        skipReason: def.skipIf === null ? null : def.skipIf(ctx),
        outputs,
      };
    }),
    blockers: new Map(),
    card: null,
  };
  remember(paths.dir, facts);
  return facts;
}

/** Блокеры входа этапа с виновником — лениво, на подпись каталога и не дольше `BLOCKERS_TTL_MS`. */
export function witokBlockers(facts: Pick<DiskFacts, 'ctx' | 'blockers'>, stage: StageId, abortHandoff = false, now: number = Date.now()): EntryProblem[] {
  const key = abortHandoff ? `${stage}:abort` : stage;
  const hit = facts.blockers.get(key);
  if (hit !== undefined && now - hit.at < BLOCKERS_TTL_MS) return hit.problems;
  const problems = entryProblems(stage, facts.ctx, readGatesCached(facts.ctx.paths.gates), {
    withBlame: true,
    ...(abortHandoff ? { abortHandoff } : {}),
  });
  facts.blockers.set(key, { at: now, problems });
  return problems;
}

/**
 * `running` — этап, идущий прямо сейчас, когда его знает не живой прогон сервера, а внешний
 * процесс (прогон стенда в своей рабочей копии): у такого витка нет `RunSummary`, но
 * незакрытый этап в ленте — это работа, а не обрыв.
 */
function witokStageFacts(facts: DiskFacts, events: EventSummary, live: RunSummary | null, runningOverride: StageId | null | undefined, now: number): StageFacts[] {
  const external = runningOverride !== undefined;
  const running = external ? runningOverride : (live?.stage ?? null);
  // Недозаполненность судится только по СВОИМ артефактам этапа: `readiness.md` производят и
  // intent, и plan, и без этого фильтра план светился проваленным, когда `plan.md` ещё нет,
  // а плейсхолдеры — в готовности, которую пишет intent.
  const earlier = new Set<string>();
  return facts.stages.map((s) => {
    const own = s.outputs.filter((a) => !earlier.has(a.name));
    for (const a of s.outputs) earlier.add(a.name);
    const id = s.def.id;
    let failedNote = id === running ? null : (events.failed.get(id) ?? null);
    // Незакрытый этап живого витка без ошибки — этап, который идёт сейчас, либо отменённый
    // только что: это не обрыв. Этап, упавший исключением, провален и у живого витка.
    const interrupted = (live !== null || external) && events.open.has(id) && id !== running && !events.openErrors.has(id);
    if (interrupted) failedNote = null;
    return {
      id,
      running: id === running,
      produced: s.produced,
      skipReason: s.skipReason,
      failedNote,
      placeholders: own.reduce((n, a) => n + (a.presence === 'placeholders' ? a.placeholders : 0), 0),
      blockers: () => witokBlockers(facts, id, false, now),
    };
  });
}

/**
 * Карточка из уже прочитанных фактов — деталь собирает её из того же снимка, что и остальное.
 * Пока входы те же (живой прогон, сводка ленты, окно блокеров), возвращается тот же объект.
 */
export function witokCardFromFacts(
  project: DashboardProjectRef,
  facts: DiskFacts,
  live: RunSummary | null,
  runningOverride?: StageId | null,
  now: number = Date.now(),
): DashboardCard {
  const events = readEventSummary(facts.ctx.paths.events);
  const key = JSON.stringify([project.key, live, events.version, runningOverride ?? '-', Math.floor(now / BLOCKERS_TTL_MS)]);
  if (facts.card !== null && facts.card.key === key) return facts.card.card;
  const source = witokSource(facts.files, facts.runnerFiles, events, live);
  const resolved = resolveStages(witokStageFacts(facts, events, live, runningOverride, now));
  const status: HistoryStatus = facts.status === 'unfinished' && live !== null ? 'open' : facts.status;
  const usage = live !== null ? live.usage : facts.usage;
  const currency = live?.currency ?? facts.currency;
  const card: DashboardCard = {
    ref: { source, project: project.key, slug: facts.ctx.paths.slug },
    ...(facts.requirement === undefined ? {} : { requirement: facts.requirement }),
    status,
    updatedAt: facts.updatedAt,
    chunk: facts.ctx.chunk,
    attempt: facts.ctx.attempt,
    stages: resolved.map((r, i) => ({
      id: r.id,
      title: facts.stages[i]!.def.title,
      state: r.state,
      blamed: r.blamed,
      note: r.note,
      outputs: facts.stages[i]!.outputs,
    })),
    usage,
    ...(currency === undefined ? {} : { currency }),
    live,
    bench: null,
    runCount: events.runIds.length,
  };
  facts.card = { key, card };
  return card;
}

/** Карточка одного витка; `null` — каталога нет и прогон не живой. */
export function witokCard(
  project: DashboardProjectRef,
  slug: string,
  live: RunSummary | null,
  runningOverride?: StageId | null,
): DashboardCard | null {
  const now = Date.now();
  const facts = diskFacts(new WitokPaths(project.projectRoot, slug), live, now);
  return facts === null ? null : witokCardFromFacts(project, facts, live, runningOverride, now);
}

/** Дисковые факты витка для детальной карточки (тот же кэш, что у списка). */
export function witokFacts(project: DashboardProjectRef, slug: string, live: RunSummary | null): DiskFacts | null {
  return diskFacts(new WitokPaths(project.projectRoot, slug), live, Date.now());
}

/**
 * Все витки проекта. `live` — живые прогоны этого корня по слагу: без них «виток идёт
 * прямо сейчас» и «брошен без записи» по одним файлам не различить. Живой виток без
 * каталога (заведён, но ещё ничего не записал) тоже получает карточку.
 */
export function scanWitoks(project: DashboardProjectRef, live: ReadonlyMap<string, RunSummary>): DashboardCard[] {
  const dir = join(project.projectRoot, SDLC_DIR);
  let entries: Dirent[] = [];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    entries = [];
  }
  const out: DashboardCard[] = [];
  const seen = new Set<string>();
  for (const e of entries) {
    // `gates.md`/`seed-log.md` — файлы проекта, не каталоги витков.
    if (!e.isDirectory()) continue;
    seen.add(e.name);
    const card = witokCard(project, e.name, live.get(e.name) ?? null);
    if (card !== null) out.push(card);
  }
  for (const [slug, summary] of live) {
    if (seen.has(slug)) continue;
    const card = witokCard(project, slug, summary);
    if (card !== null) out.push(card);
  }
  return out;
}
