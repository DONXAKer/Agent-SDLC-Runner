import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import { assessGuidedValidation } from './guidedValidation.ts';
import type { BenchResult } from './result.ts';

export const INPUTS = ['server/src', 'shared/src', 'bench/src', 'bench/fixture', 'bench/fixtures',
  'bench/checks', 'bench/expected', 'bench/acceptance', 'bench/experiments', 'bench/control.json', 'tools', 'config',
  'package.json', 'package-lock.json', 'server/package.json', 'shared/package.json'];
const safePath = z.string().min(1).refine(p => !p.includes('\\') && !p.startsWith('/') &&
  !p.includes(':') && p.split('/').every(part => part !== '' && part !== '.' && part !== '..'), 'Expected relative file path');
export const comparisonSpec = z.object({
  version: z.literal(1), hypothesis: z.string().min(1), cue: z.string().min(1), lesson: z.string().min(1),
  model: z.string().min(1), modelConfig: z.string().min(1), tasks: z.array(z.string().regex(/^[\w-]+$/u)).length(2)
    .refine(tasks => new Set(tasks).size === tasks.length, 'Distinct tasks required'),
  change: z.object({ path: safePath, before: z.string().min(1), after: z.string().min(1) }).strict(),
  limits: z.object({ attempts: z.number().int().positive(), stageMinutes: z.number().positive(), runMinutes: z.number().positive() }).strict(),
  engine: z.object({ host: z.string().url(), cache: z.literal('q8_0'), context: z.number().int().positive(),
    gpuFreeMiB: z.array(z.number().nonnegative()).min(1), gpuUtilMax: z.array(z.number().min(0).max(100)).min(1) }).strict(),
}).strict().refine(s => s.change.before !== s.change.after, 'Empty change')
  .refine(s => s.engine.gpuFreeMiB.length === s.engine.gpuUtilMax.length, 'GPU limits differ');
export type ComparisonSpec = z.infer<typeof comparisonSpec>;
export type Arm = 'A' | 'B';
export type Inventory = Record<string, string>;
export function digest(value: string | Buffer): string { return createHash('sha256').update(value).digest('hex'); }
export function stableDigest(value: unknown): string { return digest(JSON.stringify(value)); }
export function assertEngineLog(log: string, expectedGpus: number): void {
  // Check allocation evidence, not the requested command-line flags or model tensor types.
  const k = /(?:\bK\s*\(q8_0\)|\btype_k\s*[=:]\s*['"]?q8_0)/u.test(log);
  const v = /(?:\bV\s*\(q8_0\)|\btype_v\s*[=:]\s*['"]?q8_0)/u.test(log);
  if (!k || !v) throw Error('Effective q8 cache not verified for both K and V');
  const gpuBuffers = new Set([...log.matchAll(/(CUDA\d+)\s+model buffer/gu)].map(match => match[1]));
  if (gpuBuffers.size !== expectedGpus) throw Error('Model buffers are not distributed across all declared CUDA GPUs');
}
export function readJson<T>(file: string): T { return JSON.parse(readFileSync(file, 'utf8')) as T; }
export function saveJson(file: string, value: unknown): void {
  writeFileSync(file + '.new', JSON.stringify(value, null, 2) + '\n');
  for (let attempt = 0;; attempt++) {
    try { renameSync(file + '.new', file); return; }
    catch (error) {
      if (process.platform !== 'win32' || !['EPERM', 'EBUSY', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '') || attempt >= 20) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    }
  }
}
export function inventory(root: string, paths: readonly string[] = ['.']): Inventory {
  const files: Inventory = {};
  const walk = (file: string): void => {
    const stat = lstatSync(file);
    if (stat.isSymbolicLink()) throw Error(`Symlink in frozen input: ${file}`);
    if (stat.isDirectory()) {
      for (const name of readdirSync(file).sort()) walk(join(file, name));
    } else if (stat.isFile()) files[relative(root, file).split(sep).join('/')] = digest(readFileSync(file));
    else throw Error(`Unsupported input: ${file}`);
  };
  for (const path of [...paths].sort()) {
    const file = resolve(root, path);
    if (!existsSync(file)) throw Error(`Missing frozen input: ${file}`);
    walk(file);
  }
  return files;
}
export function assertPair(a: Inventory, b: Inventory, change: ComparisonSpec['change']): void {
  const changed = [...new Set([...Object.keys(a), ...Object.keys(b)])].filter(p => a[p] !== b[p]);
  if (changed.length !== 1 || changed[0] !== change.path) throw Error(`Unexpected snapshot differences: ${changed.join(', ')}`);
}
export function baselineText(candidate: string, change: ComparisonSpec['change']): string {
  const first = candidate.indexOf(change.after);
  if (first < 0 || candidate.indexOf(change.after, first + 1) >= 0) throw Error('Candidate change must occur exactly once');
  return candidate.slice(0, first) + change.before + candidate.slice(first + change.after.length);
}
export function assertExactPair(aRoot: string, bRoot: string, change: ComparisonSpec['change']): void {
  const a = readFileSync(join(aRoot, change.path), 'utf8'), b = readFileSync(join(bRoot, change.path), 'utf8');
  if (a !== baselineText(b, change)) throw Error('Snapshot difference is not the declared change');
}
export type Outcome = ReturnType<typeof assessGuidedValidation>;
export interface Evidence {
  traceCollection?: { status: 'complete' | 'incomplete'; directory: string; errors: string[] };
  claimCalls: number | null; rejectedClaims: number | null; manualRejected: number | null;
  invalidManualAnswers: number | null;
  inputTokens: number | null; outputTokens: number | null; verifyReached: boolean;
}
export interface Cell {
  id: string; arm: Arm; task: string; status: 'pending' | 'running' | 'complete' | 'interrupted';
  invocations: { slug: string; startedAt: string; finishedAt?: string; pid?: number; abandoned?: boolean; rawLogDir?: string }[];
  outcome?: Outcome; evidence?: Evidence; elapsedMs?: number; error?: string;
}
export interface Manifest {
  version: 1; spec: ComparisonSpec; specHash: string; preparedAt: string;
  status: 'prepared' | 'running' | 'waiting-gpu' | 'interrupted' | 'complete' | 'environment-failure';
  inputs: { A: Inventory; B: Inventory; common: Inventory }; nodeVersion: string; coordinatorHash: string;
  modelProfile: { id: string; provider: string; model: string; params?: Record<string, unknown> };
  engineIdentity?: unknown; cells: Cell[]; error?: string;
}
export function coordinatorHash(): string {
  return stableDigest(inventory(resolve(import.meta.dirname, '../..'), ['tools/harness-comparison.ts', 'bench/src/harnessComparison.ts',
    'bench/src/guidedValidation.ts', 'tools/guided-suite-success.ts']));
}
export function remainingRunMs(cell: Cell, limitMs: number): number {
  return Math.max(0, limitMs - cell.invocations.reduce((sum, call) => {
    if (!call.finishedAt) return sum + limitMs; // Unknown duration after a crash cannot create extra budget.
    const elapsed = Date.parse(call.finishedAt) - Date.parse(call.startedAt);
    return sum + (Number.isFinite(elapsed) && elapsed >= 0 ? elapsed : limitMs);
  }, 0));
}
export function schedule(tasks: string[]): Cell[] {
  return tasks.flatMap((task, index) => (index % 2 === 0 ? ['A', 'B'] as const : ['B', 'A'] as const)
    .map(arm => ({ id: `${index + 1}-${arm}`, arm, task, status: 'pending' as const, invocations: [] })));
}
export function recoverInterrupted(cells: Cell[], resume: boolean, alive: (pid: number) => boolean): void {
  if (!resume && cells.some(c => c.status !== 'pending')) throw Error('Use resume for an existing experiment');
  for (const cell of cells.filter(c => c.status === 'running' || c.status === 'interrupted')) {
    const call = cell.invocations.at(-1);
    if (!resume) throw Error('Interrupted invocation requires resume');
    if (call?.pid && alive(call.pid)) throw Error(`Invocation still alive: ${call.pid}`);
    if (call) call.abandoned = true;
    cell.status = 'pending'; delete cell.outcome; delete cell.evidence; delete cell.error; delete cell.elapsedMs;
  }
}
export function assertFrozen(dir: string, manifest: Manifest): void {
  if (stableDigest(manifest.spec) !== manifest.specHash || process.version !== manifest.nodeVersion || coordinatorHash() !== manifest.coordinatorHash)
    throw Error('Experiment settings, coordinator or Node version changed');
  for (const arm of ['A', 'B'] as const) {
    const actual = inventory(join(dir, 'snapshots', arm), INPUTS);
    if (stableDigest(actual) !== stableDigest(manifest.inputs[arm])) throw Error(`Frozen inputs changed in ${arm}`);
  }
  if (stableDigest(inventory(join(dir, 'common'))) !== stableDigest(manifest.inputs.common)) throw Error('Common inputs changed');
  const modelsFile = join(dir, 'common/config/models.json');
  if (existsSync(modelsFile)) {
    const selected = readJson<{ models: unknown[] }>(modelsFile).models.find(p => !!p && typeof p === 'object' && 'id' in p && p.id === manifest.spec.model);
    if (stableDigest(selected) !== stableDigest(manifest.modelProfile)) throw Error('Model profile differs from frozen configuration');
  }
  assertPair(manifest.inputs.A, manifest.inputs.B, manifest.spec.change);
  assertExactPair(join(dir, 'snapshots/A'), join(dir, 'snapshots/B'), manifest.spec.change);
}
export function collectEvidence(result: BenchResult | null, raw: unknown[]): Evidence {
  const events = raw.filter((v): v is { target?: string; accepted?: boolean; reason?: string; exchange?: {
    request?: { messages?: { role: string; content: string }[] }; response?: string } } =>
    !!v && typeof v === 'object' && 'target' in v);
  const claims = events.filter(e => e.target === 'claim-fill');
  let invalidManualAnswers = 0, inspected = 0;
  for (const entry of claims) {
    try {
      const message = entry.exchange?.request?.messages?.find(m => m.role === 'user');
      if (!message || !entry.exchange?.response) continue;
      const question = JSON.parse(message.content) as { data?: { facts?: { claim?: { manualAllowed?: boolean } } } };
      const response = JSON.parse(entry.exchange.response) as { choices?: { message?: { content?: string } }[] };
      const answer = JSON.parse(response.choices?.[0]?.message?.content ?? '') as { status?: string };
      if (!question.data?.facts?.claim) continue;
      inspected++;
      if (answer.status === 'manual' && question.data.facts.claim.manualAllowed !== true) invalidManualAnswers++;
    } catch { /* Missing/unparseable exchange is unknown, never evidence of improvement. */ }
  }
  const stages = result?.metrics?.stages;
  const tokenSum = (key: 'inputTokens' | 'outputTokens'): number | null => {
    if (!stages?.length || stages.some(s => typeof s.usage?.[key] !== 'number')) return null;
    return stages.reduce((sum, s) => sum + s.usage[key], 0);
  };
  return { claimCalls: raw.length ? claims.length : null,
    rejectedClaims: raw.length ? claims.filter(e => e.accepted === false).length : null,
    manualRejected: raw.length ? claims.filter(e => e.accepted === false && /manual/u.test(e.reason ?? '')).length : null,
    invalidManualAnswers: inspected ? invalidManualAnswers : null,
    inputTokens: tokenSum('inputTokens'), outputTokens: tokenSum('outputTokens'),
    verifyReached: result?.driver.stages.some(s => s.stage === 'verify' && !s.skipped) ?? false };
}
export const comparisonRawLogDir = (snapshot: string): string => resolve(snapshot, 'bench/traces/raw');

/** Legacy fallback is only for invocations made before the explicit path was recorded. */
export function readComparisonTraces(snapshot: string, invocation: { slug: string; rawLogDir?: string }): {
  labels: unknown[]; collection: NonNullable<Evidence['traceCollection']>;
} {
  const current = join(invocation.rawLogDir ?? comparisonRawLogDir(snapshot), invocation.slug);
  const legacy = join(snapshot, '1', invocation.slug);
  const directory = !invocation.rawLogDir && !existsSync(current) && existsSync(legacy) ? legacy : current;
  const errors: string[] = [], labels: unknown[] = [];
  if (!existsSync(directory)) errors.push('Каталог сырых трасс отсутствует');
  else {
    const files = readdirSync(directory);
    const exchanges = files.filter(n => n.endsWith('.json') && !n.endsWith('.label.json'));
    if (!exchanges.length) errors.push('Нет сырых запросов');
    for (const name of exchanges) {
      try {
        const exchange = readJson<{ slug?: string; mode?: string }>(join(directory, name));
        if (exchange.slug !== invocation.slug) throw Error('Чужой slug в трассе');
        const labelPath = join(directory, name + '.label.json');
        if (existsSync(labelPath)) {
          const label = readJson<Record<string, unknown>>(labelPath);
          if (!label || typeof label.accepted !== 'boolean' || typeof label.target !== 'string' ||
            (exchange.mode === 'claimFill' && label.target !== 'claim-fill')) throw Error('Некорректная метка проверки');
          labels.push({ ...label, exchange });
        }
        else if (exchange.mode === 'claimFill') errors.push(`${name}: отсутствует метка проверки claim`);
      } catch (error) { errors.push(`${name}: ${String(error)}`); }
    }
    for (const name of files.filter(n => n.endsWith('.label.json'))) {
      if (!files.includes(name.slice(0, -'.label.json'.length))) errors.push(`${name}: отсутствует исходный запрос`);
    }
  }
  return { labels, collection: { status: errors.length ? 'incomplete' : 'complete', directory, errors } };
}

export function collectComparisonEvidence(result: BenchResult | null, snapshot: string, invocation: { slug: string; rawLogDir?: string }): Evidence {
  const { labels, collection } = readComparisonTraces(snapshot, invocation);
  const evidence = collectEvidence(result, collection.status === 'complete' ? labels : []);
  return { ...evidence, traceCollection: collection };
}
export function lessonStatus(m: Manifest): 'candidate' | 'supported-in-pilot' {
  const a = m.cells.find(c => c.arm === 'A' && c.task === m.spec.tasks[0]);
  const b = m.cells.find(c => c.arm === 'B' && c.task === m.spec.tasks[0]);
  // A successful B alone does not show that the changed branch repaired the observed failure.
  return m.status === 'complete' && m.cells.every(c => c.evidence?.traceCollection?.status !== 'incomplete') &&
    m.cells.filter(c => c.arm === 'B').every(c => c.outcome?.success === true) &&
    a?.outcome?.status === 'failed' && a.evidence?.verifyReached === true && (a.evidence.invalidManualAnswers ?? 0) > 0 && b?.evidence?.verifyReached === true &&
    (b.evidence.manualRejected ?? 0) > 0 && m.cells.filter(c => c.arm === 'A' && c.task !== a.task)
      .every(c => !c.outcome?.success || m.cells.find(bc => bc.arm === 'B' && bc.task === c.task)?.outcome?.success)
    ? 'supported-in-pilot' : 'candidate';
}
export function report(m: Manifest): string {
  const show = (v: unknown): string => v === undefined || v === null ? 'неизвестно' : String(v).replace(/\|/gu, '\\|').replace(/[\r\n]+/gu, ' ');
  const rows = m.cells.map(c => `| ${c.arm} | ${c.task} | ${c.status} / ${show(c.outcome?.status)} | ${show(c.outcome?.success)} | ${show(c.outcome && 'failedStage' in c.outcome ? c.outcome.failedStage : null)} | ${show(c.evidence?.rejectedClaims)} | ${show(c.evidence?.inputTokens)} / ${show(c.evidence?.outputTokens)} | ${show(c.elapsedMs === undefined ? null : Math.round(c.elapsedMs / 1000))} |`);
  const traces = m.cells.map(c => `- ${c.id}: сырые трассы — ${c.evidence?.traceCollection?.status ?? 'не проверены'}; недопустимые manual: ${show(c.evidence?.invalidManualAnswers)}; отклонённые manual: ${show(c.evidence?.manualRejected)}${c.evidence?.traceCollection?.errors.length ? '; ' + c.evidence.traceCollection.errors.map(show).join('; ') : ''}`).join('\n');
  const exposed = m.cells.every(c => c.evidence?.verifyReached === true);
  return `# Парное сравнение обвязки\n\nСтатус: ${m.status}.\n\nГипотеза: ${m.spec.hypothesis}\n\nИзменение: [точный diff](change.diff), ${m.spec.change.path}.\n\nМодель: ${m.modelProfile.id}; параметры: ${JSON.stringify(m.modelProfile.params ?? {})}. Лимиты: ${JSON.stringify(m.spec.limits)}.\n\n| Вариант | Задача | Запуск / результат | Полный успех | Сбой этапа | Отказы claims | Токены вход / выход | Секунды |\n|---|---|---|---|---|---|---|---|\n${rows.join('\n')}\n\n${traces}\n\n${exposed ? 'Оба варианта дошли до Verify на обеих задачах; конкретные ветви нужно сопоставить по трассам.' : 'Не все варианты дошли до Verify: для этих пар гипотеза остаётся непроверенной.'}\n\nСтатус урока: ${lessonStatus(m)}.\n\n${m.cells.map(c => `- ${c.id}: [артефакты](runs/${c.id}/), причина: ${show(c.error ?? (c.outcome && 'reason' in c.outcome ? c.outcome.reason : null))}`).join('\n')}\n\nОграничения: по одному запуску варианта на задачу; нет оценки статистической устойчивости. Seed benchmark не является seed генерации модели. Независимые проверки обязательны; более длинная траектория не доказывает успех. Неизвестные метрики не считаются нулём. Урок не применяется автоматически.\n${m.error ? `\nОшибка среды/исполнения: ${show(m.error)}\n` : ''}`;
}
