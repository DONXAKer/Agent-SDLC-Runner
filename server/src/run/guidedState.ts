import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, isAbsolute } from 'node:path';
import type { GuidedSummary, WorkItem } from '@sdlc-runner/shared';
import type { WitokPaths } from '../artifacts/paths.ts';
import type { PlanStep } from '../artifacts/planSteps.ts';
import { readArtifact } from '../artifacts/artifact.ts';
import { preparation, planContentHash } from '../artifacts/preparation.ts';
import { symlinkEscape } from '../approval/symlink.ts';
import { escapeCell } from '../md/table.ts';

export type Snapshot = { path: string; before: string | null; after: string; previous?: string[] };
export interface GuidedState extends GuidedSummary {
  /** Durable write-ahead record; recover only bytes owned by this transaction. */
  transaction?: { itemId: string; files: Snapshot[] };
}
const pathOf = (paths: WitokPaths): string => join(paths.dir, '.runner', 'guided.json');
export const digest = (text: string): string => createHash('sha256').update(text).digest('hex');
export const guidedBudgetReason = (state: Pick<GuidedState, 'budgetMs'>): string =>
  `Лимит guided-задачи ${state.budgetMs / 60_000} минут исчерпан`;
export function guidedInputRevision(paths: WitokPaths): string {
  return digest(JSON.stringify({ requests: preparation(paths)?.requests, intent: readArtifact(paths.intent).text,
    clarifications: readArtifact(paths.clarificationReport).text, plan: planContentHash(readArtifact(paths.plan).text) }));
}
/** Current, checked source evidence for an unchanged implementation. Never fabricate a diff. */
function readGuidedSource(paths: WitokPaths, file: string): string | null {
    const path = resolve(paths.projectRoot, file);
    const back = relative(paths.projectRoot, path);
    if (isAbsolute(back) || back.startsWith('..') || symlinkEscape(paths.projectRoot, path, []) !== null) throw new Error('Путь свидетельства guided вне области');
    return existsSync(path) ? readFileSync(path, 'utf8') : null;
}
function checkedGuidedState(paths: WitokPaths): GuidedState | null {
  const state = readGuided(paths);
  if (!state || !state.items.length || state.items.some(i => i.status !== 'checked') || state.inputRevision !== guidedInputRevision(paths)) return null;
  for (const item of state.items) {
    const last = state.observations.findLast(o => o.itemId === item.id && o.kind === 'check');
    const revision = digest(JSON.stringify(item.files.map(f => { const text = readGuidedSource(paths, f); return [f, text === null ? 'missing' : digest(text)]; })));
    if (!last?.passed || last.codeRevision !== revision || last.inputRevision !== state.inputRevision) return null;
  }
  return state;
}

/** Runtime observations complete the journal only for code and inputs that still match the checks. */
export function appendGuidedJournalFacts(paths: WitokPaths, journal: string): string {
  const state = checkedGuidedState(paths);
  if (!state) return journal;
  const marker = '<!-- guided-observations:start -->';
  const block = [marker, '## Наблюдения guided', '',
    'Проверки групп выполнены рантаймом. Окончательная приёмка выполняется на Verify.', '',
    '| Группа | Файлы | Циклы проверки | Требования |', '|---|---|---|---|',
    ...state.items.map(item => `| ${escapeCell(item.id)} | ${escapeCell(item.files.join(', '))} | ${item.attempts} | ${escapeCell(item.claims.join(', '))} |`), '',
    '| Группа | Ожидание | Наблюдение | Результат | Ревизия кода |', '|---|---|---|---|---|',
    ...state.observations.filter(o => o.kind === 'check').map(o =>
      `| ${escapeCell(o.itemId)} | ${escapeCell(o.prediction)} | ${escapeCell(o.result)} | ${o.passed ? 'прошла' : 'не прошла'} | ${o.codeRevision} |`), '',
    '<!-- guided-observations:end -->',
  ].join('\n');
  return journal.includes(marker) ? journal.replace(/<!-- guided-observations:start -->[\s\S]*?<!-- guided-observations:end -->/u, () => block)
    : `${journal.trimEnd()}\n\n${block}\n`;
}

export function guidedImplementationHashes(paths: WitokPaths): Record<string, string> | null {
  const state = checkedGuidedState(paths);
  if (!state) return null;
  const hashes = Object.fromEntries([...new Set(state.items.flatMap(item => item.files))].map(file => {
    const content = readGuidedSource(paths, file);
    return [file, content === null ? 'missing' : digest(content)];
  }));
  return state.items.every(item => state.observations.findLast(o => o.itemId === item.id && o.kind === 'check')?.codeRevision ===
    digest(JSON.stringify(item.files.map(file => [file, hashes[file]])))) ? hashes : null;
}

/** Previously observed project sources ground conventions and cross-file contracts in review. */
export function guidedReviewContext(paths: WitokPaths): string {
  const state = checkedGuidedState(paths);
  if (!state) return '';
  const checked = [...new Set(state.items.flatMap(item => item.files))];
  const files = [...new Set([...checked.filter(f => /(?:^|\/)tests?\//u.test(f)), ...checked,
    ...(preparation(paths)?.readEvidence ?? []).map(e => e.path)])].slice(0, 9);
  const sources = files.map(path => ({ path, checkedImplementation: checked.includes(path),
    content: readGuidedSource(paths, path)?.slice(0, checked.includes(path) ? 4000 : 1600) ?? null }));
  const requirements = preparation(paths)?.canonical?.requirements?.acceptance ?? [];
  return JSON.stringify({ requirements, sources, partial: true,
    note: 'Сверяй соглашения об импортах и типах с показанными исходниками; проверяй импорт через публичный API.' });
}

export function guidedSourceHunks(paths: WitokPaths): { file: string; text: string }[] {
  const state = checkedGuidedState(paths);
  if (!state) return [];
  return [...new Set(state.items.flatMap(i => i.files))].flatMap(file => {
    const text = readGuidedSource(paths, file);
    return text === null ? [] : [{ file, text: `Текущий исходник ${file}; это не изменение:\n${text.split('\n').map((line, i) => `${i + 1}: ${line}`).join('\n')}` }];
  });
}
export function readGuided(paths: WitokPaths): GuidedState | null {
  const path = pathOf(paths);
  if (!existsSync(path)) return null;
  const state = JSON.parse(readFileSync(path, 'utf8')) as GuidedState;
  if (state.version !== 1 || state.mode !== 'guided' || !Array.isArray(state.items) ||
      !Array.isArray(state.observations) || !Number.isFinite(state.activeMs) || state.activeMs < 0 ||
      !Number.isFinite(state.budgetMs) || state.budgetMs <= 0) throw new Error('Повреждено состояние guided');
  return state;
}
export function saveGuided(paths: WitokPaths, state: GuidedState): void {
  // The task clock may have persisted elapsed time while a model call was in flight.
  const disk = readGuided(paths);
  if (disk) state.activeMs = Math.max(state.activeMs, disk.activeMs);
  state.remainingMs = Math.max(0, state.budgetMs - state.activeMs);
  const path = pathOf(paths);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(`${path}.tmp`, JSON.stringify(state, null, 2) + '\n', 'utf8');
  // Windows readers may briefly hold a handle without FILE_SHARE_DELETE.
  // Retry the atomic rename; never fall back to truncating the live state.
  for (let attempt = 0; ; attempt++) {
    try { renameSync(`${path}.tmp`, path); break; }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (process.platform !== 'win32' || !['EPERM', 'EACCES', 'EBUSY'].includes(code ?? '') || attempt >= 9) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
}
export function guidedSummary(paths: WitokPaths): GuidedSummary | null {
  const state = readGuided(paths);
  if (state === null) return null;
  const { transaction: _transaction, ...summary } = state;
  return summary;
}
export function accountGuidedTime(paths: WitokPaths, elapsedMs: number, running: boolean): boolean {
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0) throw new Error('Некорректный интервал времени guided');
  const state = readGuided(paths);
  if (!state) return false;
  if (running) {
    state.activeMs += elapsedMs;
    if (state.activeMs >= state.budgetMs) state.stopReason = guidedBudgetReason(state);
    saveGuided(paths, state);
  }
  return state.activeMs >= state.budgetMs;
}
export function initGuided(paths: WitokPaths, modelId: string): GuidedState {
  const old = readGuided(paths);
  if (old !== null) {
    if (old.modelId !== modelId) throw new Error('guided: смена модели внутри задачи не допускается');
    return old;
  }
  const state: GuidedState = { version: 1, mode: 'guided', modelId, budgetMs: 60 * 60_000,
    activeMs: 0, remainingMs: 60 * 60_000, inputRevision: '', currentItem: null,
    stopReason: null, items: [], observations: [] };
  saveGuided(paths, state);
  return state;
}

/** Dependency-connected edits are checked together, including contract consumers/tests. */
export function workItems(steps: readonly PlanStep[], allowed: readonly string[]): WorkItem[] {
  const ids = new Set(steps.map(s => s.n));
  if (ids.size !== steps.length) throw new Error('Повтор номера шага');
  const permitted = new Set(allowed);
  for (const step of steps) {
    if (!permitted.has(step.file)) throw new Error(`Шаг вне разрешённой области: ${step.file}`);
    if (step.dependsOn.some(id => !ids.has(id) || id === step.n)) throw new Error(`Неверная зависимость шага ${step.n}`);
    if (!step.explicit || !step.checkSpecified || step.claims.length === 0) throw new Error(`Шаг ${step.n}: нужны явные требования и проверка`);
  }
  const visited = new Set<number>();
  const visiting = new Set<number>();
  const visit = (n: number): void => {
    if (visiting.has(n)) throw new Error('Цикл зависимостей плана');
    if (visited.has(n)) return;
    visiting.add(n);
    steps.find(s => s.n === n)!.dependsOn.forEach(visit);
    visiting.delete(n); visited.add(n);
  };
  steps.forEach(s => visit(s.n));
  const groups: PlanStep[][] = [];
  const remaining = new Set(steps);
  while (remaining.size > 0) {
    const group = [remaining.values().next().value!];
    remaining.delete(group[0]!);
    for (let i = 0; i < group.length; i++) {
      const member = group[i]!;
      for (const next of remaining) {
        if (next.file === member.file || next.dependsOn.includes(member.n) || member.dependsOn.includes(next.n) ||
            next.claims.some(claim => member.claims.includes(claim))) {
          group.push(next); remaining.delete(next);
        }
      }
    }
    groups.push(group.sort((a, b) => a.n - b.n));
  }
  return groups.map((group, index) => ({ id: `work-${index + 1}`,
    title: group.map(s => `${s.title}: ${s.action}`).join('\n'),
    files: [...new Set(group.map(s => s.file))], claims: [...new Set(group.flatMap(s => s.claims))],
    dependsOn: [], prediction: group.map(s => s.expect ?? s.contractChange ?? s.action).join('\n'),
    checks: [...new Set(group.map(s => s.check ?? 'registered project gates'))],
    status: 'pending', attempts: 0, repartitioned: false }));
}
