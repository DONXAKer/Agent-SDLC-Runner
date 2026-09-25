/**
 * Детальная карточка: по каждому этапу — вход (артефакты, промпт), выход (артефакты,
 * ответ модели), доп. информация (расход, гейты, вердикт, блокеры с виновником).
 *
 * Содержимое файлов сюда не кладётся: только статусы и размеры, а текст — отдельной
 * ручкой по имени (`artifactAccess.ts`). Промпт и ответ модели — из ленты: другого места,
 * где они сохранены, нет.
 */

import { existsSync, statSync } from 'node:fs';

import type {
  DashboardArtifact,
  DashboardDetail,
  DashboardProjectRef,
  DashboardStageDetail,
  DashboardStageState,
  RunSummary,
  StageId,
} from '@sdlc-runner/shared';

import { parseIterations, readIterationsText } from '../run/iterationsLog.ts';
import { readMetricsSnapshot } from '../run/metricsSnapshot.ts';
import { stageInputs } from '../run/stages/inputs.ts';
import { readRunVerdict } from '../run/verdictStore.ts';
import { isBenchArtifactName, listWitokArtifacts } from './artifactAccess.ts';
import type { BenchArtifactName } from './artifactAccess.ts';
import { artifactStatus } from './artifacts.ts';
import type { BenchIndex } from './bench.ts';
import { readEventIndex } from './events.ts';
import { lastRecord } from './stageState.ts';
import { witokArtifactStatus, witokBlockers, witokCardFromFacts, witokFacts } from './witoks.ts';

/**
 * Условия входа показываются только у этапов, которые ещё предстоит пройти или которые
 * стоят: у пройденного это предусловия перезапуска, у идущего — уже выполненные, и список
 * из пяти причин у каждого пройденного этапа был шумом, расходящимся с карточкой.
 */
const SHOWS_BLOCKERS: ReadonlySet<DashboardStageState> = new Set(['blocked', 'notStarted', 'failed']);

export function witokDetail(
  project: DashboardProjectRef,
  slug: string,
  live: RunSummary | null,
  runningOverride?: StageId | null,
): DashboardDetail | null {
  // Один снимок диска на всю деталь: карточка, блокеры и лента — из одних фактов.
  const facts = witokFacts(project, slug, live);
  if (facts === null) return null;
  const card = witokCardFromFacts(project, facts, live, runningOverride);
  const { ctx } = facts;
  const paths = ctx.paths;
  const metrics = readMetricsSnapshot(paths);
  const stored = readRunVerdict(paths, ctx.chunk, ctx.attempt);
  // Полный индекс ленты (промпты, ответы) — только для детали, в кэше карточек его нет.
  const events = readEventIndex(paths.events);

  const stages: DashboardStageDetail[] = card.stages.map((s, i) => {
    const def = facts.stages[i]!.def;
    const inputs = stageInputs(s.id, ctx).map((inp) => witokArtifactStatus(ctx, inp.path, { optional: inp.optional }));
    const m = metrics?.stages.find((x) => x.stage === s.id);
    const shows = SHOWS_BLOCKERS.has(s.state);
    return {
      ...s,
      inputs,
      blockers: shows ? witokBlockers(facts, s.id) : [],
      // Двойной вход только у этапа с объявленным обрывом — это handoff; признак — его
      // слот приёмки, а не имя этапа.
      abortBlockers: shows && def.humanGate?.artifact === 'handoff' ? witokBlockers(facts, s.id, true) : null,
      lastRun: events.stages.get(s.id) ?? null,
      metrics: m === undefined ? null : { runs: m.runs, usage: m.usage, durationMs: m.durationMs },
      // Вердикт рантайма — только этой машины (`verdictStore`); у терминального витка его
      // нет по построению, и «нет» здесь честнее строки `passed:` из отчёта.
      storedVerdict:
        def.showsVerdict === true && stored !== null
          ? { passed: stored.passed, action: stored.action, reasons: stored.reasons, committedSha: stored.committedSha }
          : null,
      benchRecord: null,
    };
  });

  const artifacts: DashboardArtifact[] = listWitokArtifacts(paths).map((abs) => witokArtifactStatus(ctx, abs));
  return {
    card,
    serverNow: Date.now(),
    stages,
    iterations: parseIterations(readIterationsText(paths).text),
    metrics,
    runIds: events.runIds,
    artifacts,
  };
}

/** Статус файла стенда; исчезнувший между проверкой и `stat` — «нет файла», а не исключение. */
export function benchFile(name: string, abs: string): DashboardArtifact {
  let size: number | null = null;
  let mtime: string | null = null;
  try {
    const st = statSync(abs);
    size = st.size;
    mtime = new Date(st.mtimeMs).toISOString();
  } catch {
    /* нет файла */
  }
  return {
    name,
    presence: size === null ? 'missing' : 'filled',
    placeholders: 0,
    sizeBytes: size,
    mtime,
    optional: false,
    decision: null,
  };
}

/** Путь каждого файла словаря стенда — одна карта на ручку содержимого и на список файлов. */
const BENCH_FILES: Record<BenchArtifactName, (index: BenchIndex, slug: string) => string> = {
  'result.json': (i, s) => i.resultPath(s),
  'report.md': (i, s) => i.reportPath(s),
  'events.ndjson': (i, s) => i.tracePath(s),
  'progress.log': (i, s) => i.progressPath(s),
};

export function benchDetail(index: BenchIndex, slug: string): DashboardDetail | null {
  const card = index.card(slug);
  const r = index.load(slug);
  if (card === null || r === null) return null;
  const events = readEventIndex(index.tracePath(slug));
  const stages: DashboardStageDetail[] = card.stages.map((s) => {
    const rec = lastRecord(r.driver.stages, s.id);
    const m = r.metrics.stages.find((x) => x.stage === s.id);
    return {
      ...s,
      // Рабочая копия стенда удалена после прогона: входов на диске нет, есть лента.
      inputs: [],
      blockers: (rec?.blockers ?? []).map((text) => ({ text, blamed: rec?.blamedStage ?? null })),
      abortBlockers: null,
      lastRun: events.stages.get(s.id) ?? null,
      metrics: m === undefined ? null : { runs: m.runs, usage: m.usage, durationMs: m.durationMs },
      storedVerdict: null,
      benchRecord:
        rec === undefined
          ? null
          : {
              ok: rec.ok,
              note: rec.note,
              timedOut: rec.timedOut,
              skipped: rec.skipped,
              envFailure: rec.envFailure ?? null,
              turns: rec.turns ?? null,
              modelRequests: rec.modelRequests ?? null,
              closedBy: rec.closedBy ?? null,
            },
    };
  });
  const files = (Object.keys(BENCH_FILES) as BenchArtifactName[])
    .map((name) => benchFile(name, BENCH_FILES[name](index, slug)))
    .filter((a) => a.presence !== 'missing');
  return {
    card,
    serverNow: Date.now(),
    stages,
    iterations: [],
    metrics: r.metrics,
    runIds: events.runIds,
    artifacts: files,
  };
}

/** Путь файла стенда по имени словаря; `null` — имени нет в словаре или файла нет. */
export function benchArtifactPath(index: BenchIndex, slug: string, name: string): string | null {
  if (!isBenchArtifactName(name)) return null;
  const abs = BENCH_FILES[name](index, slug);
  return existsSync(abs) ? abs : null;
}
