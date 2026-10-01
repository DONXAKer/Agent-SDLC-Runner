/** Версионированная проработка. Старые витки без записи версии остаются на v1. */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, realpathSync } from 'node:fs';
import { dirname, join, relative, isAbsolute } from 'node:path';
import type { WitokPaths } from './paths.ts';
import { readArtifact, readDecision } from './artifact.ts';
import { resolvedRequirementsHash } from './resolvedRequirements.ts';
import { intentSections } from './intentSections.ts';
import { claimIdOf } from './claims.ts';
import { parseTables, columnIndex } from '../md/table.ts';
import type { PreparationSummary } from '@sdlc-runner/shared';

export interface PreparationReview {
  sourceHashes?: Record<string, string>;
  fingerprint: string;
  independent: string;
  issues: string[];
  completed: boolean;
}
export interface PreparationState {
  version: 2;
  requests: string[];
  review?: PreparationReview;
  revisions: { revision: number; requestsHash: string; requirementsHash: string; planHash: string; intent: string; clarifications: string; plan: string; approvedBy: string; approvedAt: string }[];
}

function statePath(paths: WitokPaths): string { return join(paths.dir, 'preparation.json'); }
export function preparation(paths: WitokPaths): PreparationState | null {
  const path = statePath(paths);
  if (!existsSync(path)) return null;
  const state = JSON.parse(readFileSync(path, 'utf8')) as PreparationState;
  if (state.version !== 2 || !Array.isArray(state.requests) || !Array.isArray(state.revisions)) {
    throw new Error('неподдерживаемая или повреждённая версия проработки');
  }
  return state;
}
export function isPreparationV2(paths: WitokPaths): boolean { return preparation(paths) !== null; }
export function savePreparation(paths: WitokPaths, state: PreparationState): void {
  const path = statePath(paths);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(state, null, 2) + '\n', 'utf8');
}
/** Только новый intent; открытие старого витка никогда не мигрирует его. */
export function initializePreparation(paths: WitokPaths, request?: string, version: 1 | 2 = 2): void {
  let state = preparation(paths);
  if (state === null && (version === 1 || existsSync(paths.intent) || existsSync(paths.plan) || existsSync(paths.explorationReport))) return;
  state ??= { version: 2, requests: [], revisions: [] };
  if (request !== undefined && request.trim() !== '' && state.requests.at(-1) !== request) state.requests.push(request);
  savePreparation(paths, state);
}

export function section(text: string, name: string): string { return intentSections(text).get(name)?.trim() ?? ''; }
function substantive(text: string): boolean { return text.trim().length > 0 && !/[‹›]/u.test(text); }
export function researchProblem(intent: string): string | null {
  for (const name of ['Коротко', 'Зачем', 'Что делаем', 'Чего не делаем']) {
    if (!substantive(section(intent, name))) return `для исследования заполни «${name}»: цель, результат и границы`;
  }
  return blockingQuestions(intent, true) ? 'открыт вопрос [исследование]: без него нельзя исследовать задачу' : null;
}
/** Неблокирующие вопросы разрешено сохранять открытыми. Непомеченный вопрос блокирует реализацию. */
export function blockingQuestions(text: string, researchOnly = false): boolean {
  return text.split(/\r?\n/u).some((line) => /^\s*[-*+]\s*\[\s*\]/u.test(line) &&
    (researchOnly ? /\[исследование\]/iu.test(line) : !/\[неблокирующий\]/iu.test(line)));
}
export function requirementProblem(intent: string): string | null {
  const first = researchProblem(intent);
  if (first !== null) return first;
  if (blockingQuestions(intent)) return 'остались существенные вопросы: вернись к уточнениям до реализации';
  const claims = parseTables(section(intent, 'Приёмочный лист')).flatMap((t) => t.rows);
  if (claims.length === 0) return 'нет сценариев приёмки';
  const ids = new Set<string>();
  for (const row of claims) {
    const id = claimIdOf('| ' + row.join(' | ') + ' |');
    if (id === null || ids.has(id) || !substantive(row[1] ?? '') || !substantive(row[2] ?? '')) return 'приёмка: нужны уникальные claim-N, поведение и процедура с ожидаемым результатом';
    ids.add(id);
  }
  const table = parseTables(section(intent, 'Основания и сценарии'))[0];
  const labels = ['ID', 'Основание', 'Сценарий', 'Контрпример'];
  if (table === undefined || labels.some((label) => columnIndex(table.header, label) < 0) || columnIndex(table.header, 'ID') !== 3) return 'добавь «Основания и сценарии»: Основание | Сценарий | Контрпример | ID';
  const columns = labels.map((label) => columnIndex(table.header, label));
  const seen = new Set<string>();
  for (const row of table.rows) {
    const id = (row[columns[0]!] ?? '').replace(/`/gu, '').trim();
    if (!ids.has(id) || seen.has(id) || columns.some((col) => !substantive(row[col] ?? ''))) return 'основания и сценарии должны однозначно покрывать существующие claim-N';
    seen.add(id);
  }
  return seen.size === ids.size ? null : 'у части требований нет основания, сценария или контрпримера';
}

export function planContentHash(plan: string): string {
  // Подпись добавляется после проверки; весь остальной план связан с одобрением.
  return createHash('sha256').update(plan.replace(/^.*\*\*Одобрение:\*\*.*$/gmu, '').replace(/\r\n?/gu, '\n').trimEnd()).digest('hex');
}
export function preparationFingerprint(paths: WitokPaths): string {
  return createHash('sha256').update(JSON.stringify({
    requests: preparation(paths)?.requests,
    requirements: resolvedRequirementsHash(readArtifact(paths.intent).text, readArtifact(paths.clarificationReport).text),
    plan: planContentHash(readArtifact(paths.plan).text),
    research: readArtifact(paths.explorationReport).text,
  })).digest('hex');
}
export function preparationReviewProblem(paths: WitokPaths): string | null {
  const state = preparation(paths);
  if (state === null) return null;
  const problem = requirementProblem(readArtifact(paths.intent).text);
  if (problem !== null) return problem;
  const review = state.review;
  if (review === undefined || !review.completed || review.fingerprint !== preparationFingerprint(paths) ||
      (approvedPreparationProblem(paths) !== null && !reviewSourcesCurrent(paths, review))) return 'нужна независимая проверка текущей редакции требований, плана и исходников: повтори этап plan';
  return review.issues.length === 0 ? null : 'проработка требует исправлений:\n' + review.issues.map((issue) => '- ' + issue).join('\n');
}

export function sourceHash(text: string): string { return createHash('sha256').update(text).digest('hex'); }
export function reviewSourcesCurrent(paths: WitokPaths, review: PreparationReview): boolean {
  try {
    const root = realpathSync(paths.projectRoot);
    return Object.entries(review.sourceHashes ?? {}).every(([path, hash]) => {
      const real = realpathSync(join(root, path));
      const back = relative(root, real);
      return !back.startsWith('..') && !isAbsolute(back) && sourceHash(readFileSync(real, 'utf8')) === hash;
    });
  } catch { return false; }
}
export function approvePreparation(paths: WitokPaths, operator: string, now: Date): void {
  const state = preparation(paths);
  if (state === null) return;
  const problem = preparationReviewProblem(paths);
  if (problem !== null) throw new Error(problem);
  const intent = readArtifact(paths.intent).text;
  const clarifications = readArtifact(paths.clarificationReport).text;
  const plan = readArtifact(paths.plan).text;
  const previous = state.revisions.at(-1);
  const requestsHash = sourceHash(JSON.stringify(state.requests));
  if (previous?.requestsHash === requestsHash && previous.requirementsHash === resolvedRequirementsHash(intent, clarifications) && previous.planHash === planContentHash(plan)) return;
  state.revisions.push({ revision: state.revisions.length + 1, requestsHash, requirementsHash: resolvedRequirementsHash(intent, clarifications), planHash: planContentHash(plan), intent, clarifications, plan, approvedBy: operator, approvedAt: now.toISOString() });
  savePreparation(paths, state);
}
export function approvedPreparationProblem(paths: WitokPaths): string | null {
  const state = preparation(paths);
  if (state === null) return null;
  const approved = state.revisions.at(-1);
  if (approved === undefined) return 'актуальная редакция требований и плана ещё не подтверждена человеком';
  if (readDecision(readArtifact(paths.plan).text, 'Одобрение').state !== 'granted' ||
      approved.requestsHash !== sourceHash(JSON.stringify(state.requests)) ||
      approved.requirementsHash !== resolvedRequirementsHash(readArtifact(paths.intent).text, readArtifact(paths.clarificationReport).text) ||
      approved.planHash !== planContentHash(readArtifact(paths.plan).text)) return 'требования или план изменились после подтверждения; вернись к проработке и подтверди новую редакцию';
  return null;
}
export function preparationContext(paths: WitokPaths): string | null {
  const state = preparation(paths);
  if (state === null) return null;
  const last = state.revisions.at(-1);
  return [
    '## Проработка v2: исходные запросы пользователя (дословно)', ...state.requests,
    '## Актуальные требования — intent.md', readArtifact(paths.intent).text,
    '## Решения человека — clarification-report.md', readArtifact(paths.clarificationReport).text,
    last === undefined ? 'Статус требований: черновик, подтверждения ещё нет.' : `Последняя подтверждённая редакция: ${last.revision}. ${approvedPreparationProblem(paths) ?? 'Текущие требования и план подтверждены.'}`,
    ...(last === undefined ? [] : ['## Последняя подтверждённая редакция требований для сравнения', last.intent]),
    ...(state.review === undefined ? [] : ['## Последняя критика плана (проверь актуальность)', ...state.review.issues]),
  ].join('\n\n');
}

/** Для решения человека: текущая редакция и фактические отличия от последней одобренной. */
export function preparationSummary(paths: WitokPaths): PreparationSummary | null {
  const state = preparation(paths);
  if (state === null) return null;
  const requirements = readArtifact(paths.intent).text;
  const last = state.revisions.at(-1);
  const before = intentSections(last?.intent ?? '');
  const after = intentSections(requirements);
  const confirmed = approvedPreparationProblem(paths) === null;
  const problem = preparationReviewProblem(paths);
  return {
    version: 2, fingerprint: preparationFingerprint(paths), revision: state.revisions.length + (confirmed ? 0 : 1), confirmed,
    readyToApprove: problem === null, issues: problem === null ? [] : [problem], requirements,
    changes: [...new Set([...before.keys(), ...after.keys()])].filter((name) => before.get(name) !== after.get(name)).map((name) => ({ section: name, before: before.get(name) ?? '', after: after.get(name) ?? '' })),
  };
}
