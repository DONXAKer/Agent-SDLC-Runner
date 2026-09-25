/**
 * Дашборд запусков: все витки всех проектов конфига плюс прогоны стенда — одним списком.
 *
 * Чистые функции от проектов, живых прогонов и индекса стенда: ручки `index.ts` только
 * собирают вход и отдают результат. Живые прогоны приходят готовыми `RunSummary` той же
 * функцией, что у `GET /api/runs`, — число «ждёт решений» обязано совпадать на обоих экранах.
 *
 * Порядок карточек здесь не решается: его решает клиент (`web/src/lib/dashboardSort.ts`),
 * он всё равно пересортировывает, и второе правило порядка на сервере расходилось с ним.
 */

import { createHash } from 'node:crypto';

import { DASHBOARD_BENCH_PROJECT } from '@sdlc-runner/shared';
import type {
  DashboardArtifactResponse,
  DashboardCard,
  DashboardDetail,
  DashboardProjectRef,
  DashboardResponse,
  DashboardStageDetail,
  RunSummary,
} from '@sdlc-runner/shared';

import { countPlaceholders } from '../artifacts/artifact.ts';
import { WitokPaths } from '../artifacts/paths.ts';
import { readMetricsSnapshot, usageByCurrency } from '../run/metricsSnapshot.ts';
import { intentPlaceholderCount } from '../run/stages/preconditions.ts';
import { canonicalRoot } from '../run/verdictStore.ts';
import { readCapped, resolveWitokArtifact } from './artifactAccess.ts';
import { countsPlaceholders } from './artifacts.ts';
import type { BenchIndex, ProgressRun } from './bench.ts';
import { progressCard, runningStage } from './benchProgress.ts';
import { benchArtifactPath, benchDetail, benchFile, witokDetail } from './detail.ts';
import { projectByKey } from './projects.ts';
import { scanWitoks, witokCard } from './witoks.ts';

export { dashboardProjects } from './projects.ts';
export { BenchIndex, defaultBenchDir } from './bench.ts';

/** Рабочая копия стенда как «проект»: её `.sdlc/<slug>/` читается тем же кодом, что виток. */
function workspaceProject(root: string): DashboardProjectRef {
  return { key: DASHBOARD_BENCH_PROJECT, aliases: [], projectRoot: root };
}

/** Карточка прогона без результата: по живой рабочей копии, если она есть, иначе по отметкам. */
function progressRunCard(run: ProgressRun, project: string): DashboardCard {
  const live = run.outcome.running && run.workspace !== null;
  const base = live ? witokCard(workspaceProject(run.workspace!), run.slug, null, runningStage(run.info)) : null;
  // Расход рабочей копии — по валютам МАРШРУТОВ этапов: `spent` стенда сужен до измеряемых
  // этапов (бюджет), и валюта из него подписала бы рублями сумму рублей и долларов.
  const metrics = live ? readMetricsSnapshot(new WitokPaths(run.workspace!, run.slug)) : null;
  const cost = metrics === null ? undefined : usageByCurrency(metrics.stages, (s) => run.info.currencies[s]);
  return progressCard(run.info, run.outcome, { slug: run.slug, project, mtimeMs: run.mtimeMs, base, ...(cost === undefined ? {} : { cost }) });
}

function progressRunDetail(bench: BenchIndex, run: ProgressRun): DashboardDetail {
  const card = progressRunCard(run, bench.project);
  const traceFiles = [benchFile('progress.log', bench.progressPath(run.slug))].filter((a) => a.presence !== 'missing');
  const live =
    run.outcome.running && run.workspace !== null
      ? witokDetail(workspaceProject(run.workspace), run.slug, null, runningStage(run.info))
      : null;
  if (live !== null) return { ...live, card, artifacts: [...traceFiles, ...live.artifacts] };
  const stages: DashboardStageDetail[] = card.stages.map((s) => ({
    ...s,
    inputs: [],
    blockers: [],
    abortBlockers: null,
    lastRun: null,
    metrics: null,
    storedVerdict: null,
    benchRecord: null,
  }));
  return { card, serverNow: Date.now(), stages, iterations: [], metrics: null, runIds: [], artifacts: traceFiles };
}

/** Живой прогон с корнем его проекта — ключом сведения к каталогу витков. */
export interface LiveEntry {
  projectRoot: string;
  summary: RunSummary;
}

function liveByRoot(live: readonly LiveEntry[]): Map<string, Map<string, RunSummary>> {
  const out = new Map<string, Map<string, RunSummary>>();
  for (const l of live) {
    const key = canonicalRoot(l.projectRoot);
    const bySlug = out.get(key) ?? new Map<string, RunSummary>();
    // Два живых прогона одного слага не заводятся (`POST /api/runs` закрывает простаивающий),
    // но если так вышло — показывается тот, что ждёт человека.
    const prev = bySlug.get(l.summary.slug);
    if (prev === undefined || l.summary.waiting > prev.waiting) bySlug.set(l.summary.slug, l.summary);
    out.set(key, bySlug);
  }
  return out;
}

/**
 * Индекс стенда по проекту адреса: рабочий каталог (`results`) или архив (`archive`).
 * Проект у карточки стенда — не подпись, а выбор каталога, поэтому чужое имя — «нет прогона».
 */
function benchFor(benches: readonly BenchIndex[], projectKey: string): BenchIndex | null {
  return benches.find((b) => b.project === projectKey) ?? null;
}

export function dashboardList(
  projects: readonly DashboardProjectRef[],
  live: readonly LiveEntry[],
  benches: readonly BenchIndex[],
): DashboardResponse {
  const byRoot = liveByRoot(live);
  const cards: DashboardCard[] = [];
  for (const p of projects) cards.push(...scanWitoks(p, byRoot.get(canonicalRoot(p.projectRoot)) ?? new Map()));
  let available = false;
  let skipped = 0;
  for (const bench of benches) {
    const b = bench.list();
    if (!b.available) continue;
    available = true;
    skipped += b.skipped;
    cards.push(...b.cards);
    cards.push(...bench.progress().map((run) => progressRunCard(run, bench.project)));
  }
  return { serverNow: Date.now(), cards, bench: { available, skipped } };
}

/**
 * Тело ответа списка и его метка — ОДНОЙ сериализацией. Список с сотнями прогонов стенда
 * весит мегабайты и опрашивается раз в пять секунд: сериализовать его отдельно для метки и
 * ещё раз для ответа значило делать двойную работу на каждом опросе каждой вкладки. Часы
 * сервера в метку не входят — иначе неизменный список никогда не отдавался бы ответом 304.
 */
/**
 * Сериализация карточки по объекту: неизменная карточка приходит из кэша тем же объектом
 * (`witoks.ts`, `bench.ts`), и мегабайтный список не пересериализуется целиком каждый опрос.
 */
const cardJson = new WeakMap<DashboardCard, string>();

function serializeCard(c: DashboardCard): string {
  let s = cardJson.get(c);
  if (s === undefined) {
    s = JSON.stringify(c);
    cardJson.set(c, s);
  }
  return s;
}

export function dashboardBody(r: DashboardResponse): { etag: string; body: string } {
  // Поля ответа перечислены явно ради одной сериализации; ключи обязаны совпадать с
  // `DashboardResponse` — это держит тест `dashboardWitoks.test.ts` (ключи тела = ключи ответа).
  const stable = `"cards":[${r.cards.map(serializeCard).join(',')}],"bench":${JSON.stringify(r.bench)}`;
  const etag = `"${createHash('sha1').update(stable).digest('hex')}"`;
  return { etag, body: `{"serverNow":${r.serverNow},${stable}}` };
}

/** Живой прогон витка — тем же правилом выбора, что у списка (`liveByRoot`). */
function liveFor(project: DashboardProjectRef, slug: string, live: readonly LiveEntry[]): RunSummary | null {
  return liveByRoot(live).get(canonicalRoot(project.projectRoot))?.get(slug) ?? null;
}

export type Outcome<T> = { ok: T } | { error: string; code: 400 | 404 };

/**
 * Слаг из адреса становится каталогом `.sdlc/<slug>/` — разделителей и `..` в нём быть не
 * может. Правило мягче `badSlug` нового витка: каталоги, заведённые скиллами терминала,
 * называл человек, и они обязаны открываться, раз показаны в списке.
 */
export function badWitokSlug(slug: string): string | null {
  if (slug === '' || slug === '.' || slug === '..') return 'slug не может быть пустым, «.» или «..»';
  // Выводят за каталог витка только разделители пути и NUL: имя `v1..v2` сегментом `..` не
  // является, и показанный в списке виток обязан открываться.
  if (/[\\/\0]/.test(slug)) return 'slug не может содержать разделителей пути';
  return null;
}

export function dashboardDetail(
  source: string,
  projectKey: string,
  slug: string,
  projects: readonly DashboardProjectRef[],
  live: readonly LiveEntry[],
  benches: readonly BenchIndex[],
): Outcome<DashboardDetail> {
  if (source === 'bench') {
    const bench = benchFor(benches, projectKey);
    if (bench === null || !bench.has(slug)) return { error: `прогона стенда ${slug} нет`, code: 404 };
    const run = bench.progressRun(slug);
    if (run !== null) return { ok: progressRunDetail(bench, run) };
    const d = benchDetail(bench, slug);
    return d === null ? { error: `результат ${slug} не разбирается`, code: 404 } : { ok: d };
  }
  if (source !== 'ui' && source !== 'terminal') return { error: `неизвестный источник ${source}`, code: 400 };
  const project = projectByKey(projects, projectKey);
  if (project === null) return { error: `проекта ${projectKey} нет в конфиге`, code: 404 };
  // Источник в адресе — подсказка, а не условие: виток, начатый в терминале и продолженный
  // здесь, мог сменить бейдж между опросом списка и кликом. Ответ несёт фактический.
  const d = witokDetail(project, slug, liveFor(project, slug, live));
  return d === null ? { error: `витка ${slug} нет в проекте ${project.key}`, code: 404 } : { ok: d };
}

/** Корень проекта карточки витка — для правил, которым нужен контекст (полнота задачи). */
function projectRootFor(source: string, key: string, projects: readonly DashboardProjectRef[]): string | null {
  return source === 'bench' ? null : (projectByKey(projects, key)?.projectRoot ?? null);
}

/** Растущие логи полезны хвостом: там текущий этап и строка конца. */
function readsTail(name: string): boolean {
  return name === 'progress.log' || name.endsWith('.ndjson');
}

export function dashboardArtifact(
  source: string,
  projectKey: string,
  slug: string,
  name: string,
  projects: readonly DashboardProjectRef[],
  benches: readonly BenchIndex[],
): Outcome<DashboardArtifactResponse> {
  let abs: string;
  if (source === 'bench') {
    const bench = benchFor(benches, projectKey);
    if (bench === null || !bench.has(slug)) return { error: `прогона стенда ${slug} нет`, code: 404 };
    const p = benchArtifactPath(bench, slug, name);
    const run = bench.progressRun(slug);
    if (p !== null) abs = p;
    else if (run?.workspace != null) {
      // Идущий прогон: файлы витка — из его живой рабочей копии, тем же словарём имён.
      const r = resolveWitokArtifact(new WitokPaths(run.workspace, slug), name);
      if ('error' in r) return r;
      abs = r.abs;
    } else return { error: `файла ${name} у прогона ${slug} нет`, code: 404 };
  } else if (source === 'ui' || source === 'terminal') {
    const project = projectByKey(projects, projectKey);
    if (project === null) return { error: `проекта ${projectKey} нет в конфиге`, code: 404 };
    const r = resolveWitokArtifact(new WitokPaths(project.projectRoot, slug), name);
    if ('error' in r) return r;
    abs = r.abs;
  } else {
    return { error: `неизвестный источник ${source}`, code: 400 };
  }
  let read: ReturnType<typeof readCapped>;
  try {
    read = readCapped(abs, undefined, readsTail(name) ? 'tail' : 'head');
  } catch {
    // Файл исчез между проверкой и чтением (очистка стенда) — это «нет файла», не 500.
    return { error: `файла ${name} нет`, code: 404 };
  }
  return {
    ok: {
      name,
      text: read.text,
      // Правило одно со статусом файла в списке (`countsPlaceholders`): ответ рецензента
      // цитирует шаблоны, и его `‹…›` плейсхолдерами не считаются.
      placeholders: !countsPlaceholders(name)
        ? 0
        : name === 'intent.md' && source !== 'bench'
          ? intentPlaceholderCount({ paths: new WitokPaths(projectRootFor(source, projectKey, projects) ?? '', slug), chunk: 1, attempt: 1 }, read.text, false)
          : countPlaceholders(read.text),
      sizeBytes: read.sizeBytes,
      truncated: read.truncated,
      tail: read.tail,
    },
  };
}
