/**
 * Чтение снапшота чисел витка (`.runner/metrics.json`, прежде — `metrics.json` в корне
 * каталога витка) — ОДИН читатель формата на рантайм и на дашборд.
 *
 * `Run.restoreMetrics` наполняет из результата накопители при пересоздании витка; дашборд
 * показывает те же числа архивного витка, не поднимая `Run`. Разбор снисходительный: файл
 * пишет сам рантайм, но битый или устаревший снапшот не должен ломать ни старт витка, ни
 * список запусков. Полей, которых в старом снапшоте нет (появились позже), просто не будет —
 * они читаются пустыми массивами.
 */

import type { ChunkEvidenceMetric, RedCauseKind, RunMetrics, StageId, Usage } from '@sdlc-runner/shared';
import { addUsage, emptyUsage } from '@sdlc-runner/shared';

import { readArtifact } from '../artifacts/artifact.ts';
import type { WitokPaths } from '../artifacts/paths.ts';

const list = <T,>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const numList = (v: unknown): number[] => (Array.isArray(v) ? v.filter((x): x is number => typeof x === 'number' && Number.isFinite(x)) : []);
const obj = (v: unknown): Record<string, unknown> | null =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

/**
 * Сырой объект снапшота и служебное поле `spent` (суммы по валютам — не часть `RunMetrics`:
 * гард бюджета сверяет потраченное в валюте своего маршрута). `null` — файла нет или он не
 * разбирается как объект.
 */
export function readMetricsRaw(paths: WitokPaths): { raw: Record<string, unknown>; spent: Record<string, unknown> | null } | null {
  // Прежнее место снапшота читается для витков, начатых до переезда служебных файлов
  // раннера в `.runner/`; запись — только в новое.
  const fresh = readArtifact(paths.metrics);
  const a = fresh.exists ? fresh : readArtifact(paths.metricsLegacy);
  if (!a.exists) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(a.text);
  } catch {
    return null;
  }
  const raw = obj(parsed);
  if (raw === null) return null;
  return { raw, spent: obj(raw['spent']) };
}

/** Снисходительный разбор объекта в `RunMetrics`: чужое и битое отбрасывается построчно. */
export function normalizeMetrics(input: unknown): RunMetrics {
  const m = obj(input) ?? {};
  const stages: RunMetrics['stages'] = [];
  for (const s of list<Record<string, unknown> | null>(m['stages'])) {
    if (typeof s?.['stage'] !== 'string') continue;
    const u = obj(s['usage']);
    stages.push({
      stage: s['stage'] as StageId,
      runs: num(s['runs']),
      usage: { ...emptyUsage(), ...(u === null ? {} : (u as object)) },
      durationMs: num(s['durationMs']),
      requestDurationsMs: numList(s['requestDurationsMs']),
    });
  }
  const verdicts = obj(m['verdicts']);
  const redByCause: RunMetrics['redByCause'] = [];
  for (const c of list<Record<string, unknown> | null>(m['redByCause'])) {
    if (typeof c?.['kind'] !== 'string') continue;
    redByCause.push({ kind: c['kind'] as RedCauseKind, count: num(c['count']) });
  }
  const attemptsByChunk: RunMetrics['attemptsByChunk'] = [];
  for (const c of list<Record<string, unknown> | null>(m['attemptsByChunk'])) {
    if (typeof c?.['chunk'] !== 'number') continue;
    attemptsByChunk.push({ chunk: c['chunk'], attempts: num(c['attempts']) });
  }
  const friction: RunMetrics['friction'] = [];
  for (const f of list<Record<string, unknown> | null>(m['friction'])) {
    if (typeof f?.['stage'] !== 'string') continue;
    friction.push({
      stage: f['stage'] as StageId,
      repeat: num(f['repeat']),
      badJson: num(f['badJson']),
      denied: num(f['denied']),
      truncated: num(f['truncated']),
      toolCalls: num(f['toolCalls']),
      reminders: num(f['reminders']),
    });
  }
  const gates: RunMetrics['gates'] = [];
  for (const g of list<Record<string, unknown> | null>(m['gates'])) {
    if (typeof g?.['gate'] !== 'string') continue;
    gates.push({
      gate: g['gate'],
      runs: num(g['runs']),
      red: num(g['red']),
      skippedWhileEnabled: num(g['skippedWhileEnabled']),
      durationMs: num(g['durationMs']),
    });
  }
  const human: RunMetrics['human'] = [];
  for (const h of list<Record<string, unknown> | null>(m['human'])) {
    if (typeof h?.['stage'] !== 'string') continue;
    human.push({
      stage: h['stage'] as StageId,
      questions: num(h['questions']),
      approvals: num(h['approvals']),
      waitMs: num(h['waitMs']),
    });
  }
  const artifactGaps: RunMetrics['artifactGaps'] = [];
  for (const g of list<Record<string, unknown> | null>(m['artifactGaps'])) {
    if (typeof g?.['artifact'] !== 'string') continue;
    artifactGaps.push({ artifact: g['artifact'], placeholders: num(g['placeholders']) });
  }
  const chunkEvidence: ChunkEvidenceMetric[] = [];
  for (const e of list<Record<string, unknown> | null>(m['chunkEvidence'])) {
    if (typeof e?.['chunk'] !== 'number' || typeof e['attempt'] !== 'number') continue;
    const t = e['testsStatus'];
    chunkEvidence.push({
      chunk: e['chunk'],
      attempt: e['attempt'],
      testsStatus: t === '✅' || t === '❌' || t === '⏭' ? t : '⏭',
      treeChanged: e['treeChanged'] === true,
      scopeViolation: e['scopeViolation'] === true,
    });
  }
  return {
    stages,
    verdicts: { total: num(verdicts?.['total']), red: num(verdicts?.['red']) },
    redByCause,
    attemptsByChunk,
    friction,
    gates,
    human,
    artifactGaps,
    chunkEvidence,
  };
}

/** Числа витка с диска; `null` — снапшота нет или он не разбирается. */
export function readMetricsSnapshot(paths: WitokPaths): RunMetrics | null {
  const r = readMetricsRaw(paths);
  return r === null ? null : normalizeMetrics(r.raw);
}

/**
 * Сумма расхода по этапам и её валюта — ОДНО правило на витки и прогоны стенда: валюта
 * называется, только если все этапы, которые реально тратили, считали в одной. Рубли с
 * долларами в одну сумму не складываются — у смешанного расхода стоимости нет, токены есть.
 * `currencyOf` — валюта маршрута этапа; неизвестна — USD (умолчание провайдера).
 */
export function usageByCurrency(
  stages: RunMetrics['stages'],
  currencyOf: (stage: StageId) => string | undefined,
): { usage: Usage; currency: string | undefined } {
  let usage = emptyUsage();
  const currencies = new Set<string>();
  for (const s of stages) {
    usage = addUsage(usage, s.usage);
    if ((s.usage.costUsd ?? 0) > 0) currencies.add(currencyOf(s.stage) ?? 'USD');
  }
  if (currencies.size > 1) return { usage: { ...usage, costUsd: null }, currency: undefined };
  return { usage, currency: [...currencies][0] };
}
