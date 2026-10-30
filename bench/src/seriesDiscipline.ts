/**
 * Дисциплина серии стенда — в коде, а не в README. Чистые функции над манифестом матрицы
 * (`tools/guided-matrix.ts`), каждая закрывает одно измеренное нарушение серий r1–r4:
 *
 * - пилот-гейт: матрица 6×5 стартовала на протоколе с нулевым пилотом; требование
 *   «1 модель × 1 задача × ≥3 повтора с успехом» было только в README симулятора;
 * - отпечаток исходников: между сериями менялось 3–7 модулей, журнал называл это «один
 *   фикс»; манифест обязан показать, что именно изменилось относительно предыдущей серии;
 * - допуск клетки: ministral с квалификацией 8/12 гонялся 5 клеток, devstral на 6,6 ток/с
 *   упирался в потолок стенных часов ×3 — часы GPU, не измерившие ничего. Отказ по
 *   квалификации, паспорту или арифметике контекста — класс `preflight`, не отказ модели;
 * - GPU wait: исчерпанный бюджет ожидания обрывал серию (`stopped`, 15/30 в r2) — вместо
 *   этого пауза с возобновлением;
 * - сильный контрольный ряд: без него «модели слабые» неотличимо от «раннер отвергает верные
 *   ответы»;
 * - «сдвиг» класса отказа при n=1 на стохастической модели — шум, не сигнал.
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import type { Qualification } from './modelQualification.ts';
import { wallclockScale, type ThroughputPassport } from './modelPassport.ts';
import { contextVerdict, type PacketProfile } from './contextPreflight.ts';

/** Клетка в объёме, нужном дисциплине; совместима с `Cell` матрицы и манифестом валидации. */
export interface DisciplineCell { model: string; task: string; success: boolean | null }

export interface PilotGateInput {
  cells: readonly DisciplineCell[];
  /** Минимум повторов одной пары (модель, задача). */
  minRepeats?: number;
  /** Минимум успешных повторов среди них. */
  minSuccesses?: number;
}

export interface PilotGateVerdict {
  ok: boolean;
  reason: string;
  /** Пары (модель|задача) → [повторов, успехов]. */
  pairs: Record<string, { repeats: number; successes: number }>;
}

/** Матрица не стартует без пилота: одна пара с ≥minRepeats повторами и ≥minSuccesses успехами. */
export function pilotGate(input: PilotGateInput): PilotGateVerdict {
  const minRepeats = input.minRepeats ?? 3;
  const minSuccesses = input.minSuccesses ?? 1;
  const pairs: Record<string, { repeats: number; successes: number }> = {};
  for (const cell of input.cells) {
    const key = `${cell.model}|${cell.task}`;
    const entry = pairs[key] ?? (pairs[key] = { repeats: 0, successes: 0 });
    entry.repeats++;
    if (cell.success === true) entry.successes++;
  }
  const passing = Object.entries(pairs).filter(([, value]) => value.repeats >= minRepeats && value.successes >= minSuccesses);
  if (passing.length > 0) return { ok: true, reason: `пилот пройден: ${passing.map(([key, value]) => `${key} — ${value.successes}/${value.repeats}`).join('; ')}`, pairs };
  const best = Object.entries(pairs).sort((a, b) => b[1].successes - a[1].successes || b[1].repeats - a[1].repeats)[0];
  return { ok: false, pairs,
    reason: best === undefined
      ? `пилота нет: матрица требует ≥${minRepeats} повторов одной пары (модель, задача) с ≥${minSuccesses} успехом`
      : `пилот не пройден: лучшая пара ${best[0]} — ${best[1].successes}/${best[1].repeats}, нужно ≥${minSuccesses} успеха из ≥${minRepeats} повторов` };
}

/** Отпечаток продуктовых исходников по файлам: сравнение серий называет изменённые модули, а не только «хеш другой». */
export interface SourceFingerprint { digest: string; files: Record<string, string> }

const PRODUCT_DIRS = ['server/src', 'shared/src', 'bench/src', 'tools'] as const;

function treeFiles(root: string, prefix = ''): string[] {
  if (!existsSync(join(root, prefix))) return [];
  return readdirSync(join(root, prefix), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap(entry => {
    if (entry.isSymbolicLink()) return [];
    if (['.git', '.runner', '.sdlc', 'node_modules'].includes(entry.name)) return [];
    const path = prefix + entry.name;
    return entry.isDirectory() ? treeFiles(root, path + '/') : [path];
  });
}

export function sourceFingerprint(root: string, dirs: readonly string[] = PRODUCT_DIRS): SourceFingerprint {
  const files: Record<string, string> = {};
  for (const dir of dirs) {
    for (const file of treeFiles(join(root, dir))) {
      const path = `${dir}/${file}`;
      files[path] = createHash('sha256').update(readFileSync(join(root, dir, file))).digest('hex');
    }
  }
  const digest = createHash('sha256');
  for (const path of Object.keys(files).sort()) digest.update(path).update(files[path]!);
  return { digest: digest.digest('hex'), files };
}

export interface SourceDiff { changed: string[]; added: string[]; removed: string[]; modules: number }

/**
 * Что изменилось между сериями; `modules` — число затронутых файлов (правило журнала: одна
 * серия — одно изменение). На вход годится и `inputs` манифеста матрицы — тот же словарь
 * путь → хеш, снятый с замороженного снимка.
 */
export function sourceDiff(previous: Pick<SourceFingerprint, 'files'>, current: Pick<SourceFingerprint, 'files'>): SourceDiff {
  const changed: string[] = [], added: string[] = [], removed: string[] = [];
  for (const [path, hash] of Object.entries(current.files)) {
    const before = previous.files[path];
    if (before === undefined) added.push(path);
    else if (before !== hash) changed.push(path);
  }
  for (const path of Object.keys(previous.files)) if (!(path in current.files)) removed.push(path);
  return { changed: changed.sort(), added: added.sort(), removed: removed.sort(), modules: changed.length + added.length + removed.length };
}

export function formatSourceDiff(diff: SourceDiff, limit = 12): string {
  if (diff.modules === 0) return 'исходники не менялись относительно предыдущей серии';
  const list = [...diff.changed.map(p => `~${p}`), ...diff.added.map(p => `+${p}`), ...diff.removed.map(p => `−${p}`)];
  const shown = list.slice(0, limit).join(', ');
  return `изменено модулей: ${diff.modules}${diff.modules > 1 ? ' (правило журнала — одно изменение на серию)' : ''}: ${shown}${list.length > limit ? `, ещё ${list.length - limit}` : ''}`;
}

/** Допуск клетки к запуску — до загрузки модели. */
export interface CellAdmissionInput {
  qualification: Qualification | undefined;
  passport: ThroughputPassport | null | undefined;
  wallclock?: { referenceDecisionSeconds: number; maxScale: number } | undefined;
  /** Профиль пакетов задачи и окно модели — арифметика контекста; `null` — профиля нет, не судится. */
  context?: { profile: PacketProfile; contextWindow: number | undefined; reasoning?: 'none' | 'light' | 'heavy' | undefined } | null | undefined;
}

export type CellAdmission = { admit: true; notes: string[] } | { admit: false; failureClass: 'preflight'; reason: string };

/**
 * Красные причины: квалификация протокола FAIL (ранее для v5 клетка всё равно шла, если
 * транспорт «совместим»), паспорт скорости упирается в потолок стенных часов (клетка
 * гарантированно не уложится — r1 devstral ×3 на plan), арифметика контекста (решение не
 * стартует). Паспорта нет — предупреждение, не красный: отсутствие usage — свойство
 * провайдера, а не модели.
 */
export function cellAdmission(input: CellAdmissionInput): CellAdmission {
  const notes: string[] = [];
  if (input.qualification === undefined) return { admit: false, failureClass: 'preflight', reason: 'квалификация протокола не проводилась' };
  if (!input.qualification.passed) {
    const cases = input.qualification.cases;
    return { admit: false, failureClass: 'preflight', reason: `квалификация протокола FAIL (${cases.filter(c => c.passed).length}/${cases.length}); клетка не запускается` };
  }
  if (input.passport === null || input.passport === undefined) notes.push('паспорта скорости нет — лимиты без масштаба');
  else if (input.wallclock !== undefined) {
    const scale = wallclockScale(input.passport, input.wallclock);
    const raw = input.passport.secondsPerDecision / input.wallclock.referenceDecisionSeconds;
    if (raw > input.wallclock.maxScale) {
      return { admit: false, failureClass: 'preflight', reason: `паспорт скорости ${input.passport.secondsPerDecision} с/решение — ×${raw.toFixed(1)} опоры при потолке ×${input.wallclock.maxScale}; стенные часы клетки не вместят виток` };
    }
    notes.push(`стенные часы ×${scale}`);
  }
  if (input.context) {
    const verdict = contextVerdict(input.context.profile, { windowFor: () => input.context!.contextWindow, reasoning: input.context.reasoning });
    const fails = verdict.findings.filter(f => f.severity === 'fail');
    if (fails.length > 0) {
      return { admit: false, failureClass: 'preflight', reason: `арифметика контекста: ${fails.map(f => `${f.stage}/${f.schema} окно ${f.window} − пакет ${f.promptTokens} − 512 = ${f.remaining} < ${f.minOutput}`).join('; ')}` };
    }
    const tight = verdict.findings.filter(f => f.severity === 'tight');
    if (tight.length > 0) notes.push(`обрезка вероятна: ${tight.map(f => `${f.stage}/${f.schema}`).join(', ')}`);
    if (verdict.unknownWindow.length > 0) notes.push('окно модели не задано — контекст не проверен');
  }
  return { admit: true, notes };
}

/** Что делать при исчерпании бюджета ожидания GPU: пауза с возобновлением, не остановка серии. */
export interface GpuWaitState { waitedMs: number; budgetMs: number; deadlineMs: number; nowMs: number }
export type GpuWaitDecision = { action: 'wait' } | { action: 'pause'; reason: string } | { action: 'stop'; reason: string };

export function gpuWaitDecision(state: GpuWaitState): GpuWaitDecision {
  if (state.nowMs >= state.deadlineMs) return { action: 'stop', reason: 'исчерпан бюджет времени серии (suiteHours)' };
  if (state.waitedMs >= state.budgetMs) return { action: 'pause', reason: `GPU занят дольше ${Math.round(state.budgetMs / 60000)} мин — серия приостановлена; возобновление тем же запуском, клетки остаются pending` };
  return { action: 'wait' };
}

/** Сильный контрольный ряд: хотя бы одна модель серии названа контролем и входит в список моделей. */
export function controlRowProblem(spec: { models: readonly string[]; control?: readonly string[] | undefined }): string | null {
  const control = spec.control ?? [];
  if (control.length === 0) return 'в спецификации нет сильного контрольного ряда (`control: [...]`): без него «модели слабые» неотличимо от «раннер отвергает верные ответы»';
  const missing = control.filter(id => !spec.models.includes(id));
  if (missing.length > 0) return `контрольные модели не входят в models: ${missing.join(', ')}`;
  return null;
}

/** Подпись сдвига класса отказа: при одном повторе сдвиг не утверждается. */
export function shiftLabel(from: string | undefined, to: string | undefined, repetitions: number): string {
  if (from === undefined || to === undefined) return '—';
  if (repetitions < 2) return from === to ? `= ${to}` : `${from} → ${to} (n=1 — не сдвиг)`;
  return from === to ? `= ${to}` : `${from} → ${to}`;
}
