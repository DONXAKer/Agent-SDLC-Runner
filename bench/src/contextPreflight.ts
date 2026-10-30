/**
 * Преполёт по арифметике контекста: минимальный пакет решения на (этап, схема) задачи против
 * окна модели — ДО запуска клетки, а не классом отказа после неё.
 *
 * Зачем: реплей-корпус r1–r4 (`bench/corpus/replay/`) показал, что 53 % отказов валидации —
 * обрезка по `max_tokens`, а отказы «Mandatory decision context does not fit» на окне 16k
 * предсказуемы заранее. Ни один фикс протокола на этот класс не был направлен, потому что он
 * не виден как класс: клетка просто краснеет через часы GPU.
 *
 * Источник чисел — не оценка по тексту задачи, а сырые обмены прошлых серий (`raw/`): размер
 * промпта по `usage.prompt_tokens` провайдера (токенизатор самой модели; без usage — оценка
 * `estimateMessageTokens`) и размер ПОЛНЫХ ответов (`finish_reason: stop`). Пакет решения
 * на (этап, схема) зависит от задачи и артефактов, а не от модели — минимум по моделям и есть
 * «минимальный пакет»; разброс вверх — ужатие/расширение пакета рантаймом по ходу витка.
 *
 * Профиль задачи — данные стенда (`bench/corpus/packets/<task>.json`), собираются CLI этого
 * модуля; преполёт читает их и считает ту же арифметику, что `DecisionEngine`:
 * `окно − промпт − 512 ≥ minOutput`, иначе решение не стартует вовсе. Профиль без серии по
 * задаче — не ошибка, а «проверить нечем»: преполёт говорит это словами, не зеленит молча.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { estimateMessageTokens, MIN_MAX_TOKENS } from '../../server/src/exec/contextBudget.ts';
import { completionLadder, type ReasoningProfile } from '../../server/src/exec/completionBudget.ts';
import { seriesRuns, type RawExchange } from './replayCorpus.ts';

/** Запас окна под обёртку чат-шаблона — та же константа, что в `DecisionEngine` (`- 512`). */
export const DECISION_WRAPPER_RESERVE = 512;

export interface PacketStat {
  stage: string;
  schema: string;
  /** Минимальный промпт по всем обменам (токены по usage провайдера либо оценка). */
  minPromptTokens: number;
  /** Медианный промпт — типичный пакет с учётом ужатий/расширений по ходу витка. */
  p50PromptTokens: number;
  /** Максимальный промпт — сколько пакет вырастал в худшем случае. */
  maxPromptTokens: number;
  /** p90 размера ответов, завершённых полностью (`finish_reason: stop`); null — ни одного полного. */
  p90CompletionTokens: number | null;
  samples: number;
  completeSamples: number;
  /** Сколько обменов дали промпт по usage провайдера, а не оценкой. */
  measuredSamples: number;
}

export interface PacketProfile {
  version: 1;
  task: string;
  builtFrom: string[];
  builtAt: string;
  packets: PacketStat[];
}

export interface ContextVerdictInput {
  /** Окно модели для этапа; `undefined` — окно маршрута не задано. */
  windowFor: (stage: string) => number | undefined;
  reasoning?: ReasoningProfile | undefined;
  /** Этапы, которые будут измерены; остальные пакеты профиля не судятся. */
  stages?: readonly string[] | undefined;
}

export interface ContextFinding {
  stage: string;
  schema: string;
  window: number;
  promptTokens: number;
  /** Минимум выхода, ниже которого `DecisionEngine` отказывает до запроса (`context-required`). */
  minOutput: number;
  /** p90 полного ответа — сколько нужно, чтобы ответ не обрезался. */
  needOutput: number | null;
  remaining: number;
  /** `fail` — решение не стартует; `tight` — стартует, но полный ответ в остаток не помещается. */
  severity: 'fail' | 'tight';
}

export interface ContextVerdict {
  ok: boolean;
  findings: ContextFinding[];
  /** Этапы профиля, окно которых не задано — проверить нечем. */
  unknownWindow: string[];
  judged: number;
}

const percentile = (sorted: readonly number[], share: number): number => {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(share * sorted.length) - 1));
  return sorted[index]!;
};

interface Sample { stage: string; schema: string; prompt: number; measured: boolean; completion: number | null }

function sampleOf(raw: RawExchange): Sample | null {
  const schema = raw.request?.response_format?.json_schema?.name;
  if (typeof schema !== 'string' || schema === '') return null;
  let usage: { prompt_tokens?: unknown; completion_tokens?: unknown } | undefined;
  let finish: unknown;
  try {
    const parsed = JSON.parse(raw.response) as { usage?: typeof usage; choices?: { finish_reason?: unknown }[] };
    usage = parsed.usage;
    finish = parsed.choices?.[0]?.finish_reason;
  } catch { /* ответ не JSON — размер промпта всё равно оценим по запросу */ }
  const measured = typeof usage?.prompt_tokens === 'number' && usage.prompt_tokens > 0;
  const prompt = measured ? usage!.prompt_tokens as number
    : estimateMessageTokens((raw.request?.messages ?? []).map(message => ({ content: message.content })));
  if (prompt <= 0) return null;
  const completion = finish === 'stop' && typeof usage?.completion_tokens === 'number' ? usage.completion_tokens : null;
  return { stage: raw.stage, schema, prompt, measured, completion };
}

/** Профили пакетов по задачам из сырых обменов серий. */
export function buildPacketProfiles(seriesDirs: readonly string[]): Map<string, PacketProfile> {
  const samples = new Map<string, Sample[]>();
  const sources = new Map<string, Set<string>>();
  for (const seriesDir of seriesDirs) {
    const series = seriesDir.replace(/[\\/]+$/u, '').split(/[\\/]/u).pop() ?? seriesDir;
    const runs = seriesRuns(seriesDir);
    const rawRoot = join(seriesDir, 'raw');
    if (!existsSync(rawRoot)) continue;
    for (const slug of readdirSync(rawRoot, { withFileTypes: true })) {
      if (!slug.isDirectory()) continue;
      const task = runs.get(slug.name)?.task ?? null;
      if (task === null) continue;
      const dir = join(rawRoot, slug.name);
      for (const name of readdirSync(dir)) {
        if (!name.endsWith('.json') || name.endsWith('.label.json')) continue;
        let raw: RawExchange;
        try { raw = JSON.parse(readFileSync(join(dir, name), 'utf8')) as RawExchange; } catch { continue; }
        const sample = sampleOf(raw);
        if (sample === null) continue;
        samples.set(task, [...(samples.get(task) ?? []), sample]);
        sources.set(task, (sources.get(task) ?? new Set()).add(series));
      }
    }
  }
  const profiles = new Map<string, PacketProfile>();
  for (const [task, list] of samples) {
    const byKey = new Map<string, Sample[]>();
    for (const sample of list) {
      const key = `${sample.stage}\u0000${sample.schema}`;
      byKey.set(key, [...(byKey.get(key) ?? []), sample]);
    }
    const packets: PacketStat[] = [...byKey.values()].map(group => {
      const prompts = group.map(sample => sample.prompt).sort((a, b) => a - b);
      const completions = group.flatMap(sample => sample.completion === null ? [] : [sample.completion]).sort((a, b) => a - b);
      return {
        stage: group[0]!.stage, schema: group[0]!.schema,
        minPromptTokens: prompts[0]!, p50PromptTokens: percentile(prompts, 0.5), maxPromptTokens: prompts.at(-1)!,
        p90CompletionTokens: completions.length === 0 ? null : percentile(completions, 0.9),
        samples: group.length, completeSamples: completions.length,
        measuredSamples: group.filter(sample => sample.measured).length,
      };
    }).sort((a, b) => a.stage.localeCompare(b.stage) || a.schema.localeCompare(b.schema));
    profiles.set(task, { version: 1, task, builtFrom: [...(sources.get(task) ?? [])].sort(), builtAt: new Date().toISOString(), packets });
  }
  return profiles;
}

/**
 * Арифметика `DecisionEngine` на профиле: решение стартует, если
 * `окно − минимальный промпт − 512 ≥ max(MIN_MAX_TOKENS, min(1024, старт лестницы))`;
 * ответ не обрежется, если в остаток помещается p90 полного ответа.
 */
export function contextVerdict(profile: PacketProfile, input: ContextVerdictInput): ContextVerdict {
  const findings: ContextFinding[] = [];
  const unknownWindow = new Set<string>();
  let judged = 0;
  for (const packet of profile.packets) {
    if (input.stages !== undefined && !input.stages.includes(packet.stage)) continue;
    const window = input.windowFor(packet.stage);
    if (window === undefined) { unknownWindow.add(packet.stage); continue; }
    judged++;
    const ladder = completionLadder({ contextWindow: window, promptTokens: 0, reserve: 0, reasoning: input.reasoning });
    const minOutput = Math.max(MIN_MAX_TOKENS, Math.min(1024, ladder.start));
    const remaining = window - packet.minPromptTokens - DECISION_WRAPPER_RESERVE;
    const base = { stage: packet.stage, schema: packet.schema, window, promptTokens: packet.minPromptTokens, minOutput, needOutput: packet.p90CompletionTokens, remaining };
    if (remaining < minOutput) findings.push({ ...base, severity: 'fail' });
    else if (packet.p90CompletionTokens !== null && remaining < packet.p90CompletionTokens) findings.push({ ...base, severity: 'tight' });
  }
  return { ok: !findings.some(finding => finding.severity === 'fail'), findings, unknownWindow: [...unknownWindow].sort(), judged };
}

export function formatContextFinding(finding: ContextFinding): string {
  const need = finding.severity === 'fail'
    ? `нужно ≥${finding.minOutput} на ответ`
    : `полный ответ p90 ≈${finding.needOutput} токенов`;
  return `${finding.stage}/${finding.schema}: окно ${finding.window} − пакет ${finding.promptTokens} − ${DECISION_WRAPPER_RESERVE} = ${finding.remaining}, ${need}`;
}

export function packetProfilePath(benchDir: string, task: string): string {
  return join(benchDir, 'corpus', 'packets', `${task}.json`);
}

export function loadPacketProfile(benchDir: string, task: string): PacketProfile | null {
  const path = packetProfilePath(benchDir, task);
  if (!existsSync(path)) return null;
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<PacketProfile>;
  return parsed.version === 1 && parsed.task === task && Array.isArray(parsed.packets) ? parsed as PacketProfile : null;
}

export function writePacketProfiles(benchDir: string, profiles: ReadonlyMap<string, PacketProfile>): string[] {
  const written: string[] = [];
  for (const [task, profile] of profiles) {
    const path = packetProfilePath(benchDir, task);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(profile, null, 2)}\n`, 'utf8');
    written.push(path);
  }
  return written;
}

function argValues(name: string): string[] {
  const prefix = `--${name}=`;
  return process.argv.slice(2).filter(value => value.startsWith(prefix)).map(value => resolve(value.slice(prefix.length)));
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const series = argValues('series');
  if (series.length === 0) { process.stderr.write('Использование: node bench/src/contextPreflight.ts --series=<каталог серии> [--series=…]\n'); process.exit(2); }
  const benchDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const profiles = buildPacketProfiles(series);
  const written = writePacketProfiles(benchDir, profiles);
  const summary = [...profiles.values()].map(profile => ({
    task: profile.task, packets: profile.packets.length,
    minPromptByStage: Object.fromEntries([...new Set(profile.packets.map(packet => packet.stage))].map(stage =>
      [stage, Math.max(...profile.packets.filter(packet => packet.stage === stage).map(packet => packet.minPromptTokens))])),
  }));
  process.stdout.write(`${JSON.stringify({ written, summary }, null, 2)}\n`);
}
