/**
 * Реестр этапов витка: порядок, поиск по id, этап-производитель артефакта и проверка
 * предусловий. Определения этапов живут в файлах этапов (`intent.ts`, `explore.ts`, …).
 */

import type { StageId } from '@sdlc-runner/shared';
import { askModule, askStage } from './ask.ts';
import { chunkModule, chunkStage } from './chunk/index.ts';
import { exploreModule, exploreStage } from './explore.ts';
import { handoffModule, handoffStage } from './handoff.ts';
import { intentModule, intentStage } from './intent.ts';
import { planModule, planStage } from './plan.ts';
import type { PreconditionOptions, PreconditionProblem, PreconditionReport, StageContext, StageDef, StageModule } from './types.ts';
import { verifyModule, verifyStage } from './verify/index.ts';

// ── этапы ──────────────────────────────────────────────────────────────────

export const STAGES: readonly StageDef[] = [intentStage, exploreStage, askStage, planStage, chunkStage, verifyStage, handoffStage];

/** Модули этапов по id: отличия этапа в рантайме — здесь, а не ветвлениями по имени этапа. */
export const STAGE_MODULES: Readonly<Record<StageId, StageModule>> = {
  intent: intentModule,
  explore: exploreModule,
  ask: askModule,
  plan: planModule,
  chunk: chunkModule,
  verify: verifyModule,
  handoff: handoffModule,
};

export function stageModule(id: StageId): StageModule {
  return STAGE_MODULES[id];
}

export function stageById(id: StageId): StageDef {
  const s = STAGES.find((x) => x.id === id);
  if (s === undefined) throw new Error(`неизвестный этап: ${id}`);
  return s;
}

export function isStageId(v: unknown): v is StageId {
  return typeof v === 'string' && STAGES.some((s) => s.id === v);
}

/**
 * Этап-виновник: ПОСЛЕДНИЙ до `before`, чей артефакт — `path`.
 *
 * Последний, а не первый: `readiness.md` производят и intent, и plan, и вход в chunk
 * заваливает уже план. Патч попытки в `produces` chunk'а не значится (его пишет рантайм
 * по дереву), но отвечает за него всё равно chunk.
 */
export function stageProducing(path: string, before: StageId, c: StageContext): StageId | null {
  const norm = (p: string): string => p.replace(/\\/g, '/');
  const target = norm(path);
  const limit = STAGES.findIndex((s) => s.id === before);
  for (let i = (limit < 0 ? STAGES.length : limit) - 1; i >= 0; i--) {
    const s = STAGES[i]!;
    const produced = s.id === 'chunk' ? [...s.produces(c), c.paths.chunkDiff(c.chunk, c.attempt)] : s.produces(c);
    if (produced.some((p) => norm(p) === target)) return s.id;
  }
  return null;
}

export function checkPreconditions(
  stage: StageDef,
  c: StageContext,
  opts: PreconditionOptions = {},
): PreconditionReport {
  const problems: string[] = [];
  const details: PreconditionProblem[] = [];

  const skipVerdictCheck = stage.id === 'handoff' && opts.abortHandoff === true;
  for (const p of stage.requires) {
    if (skipVerdictCheck) continue;
    const problem = p.check(c);
    if (problem === null) continue;
    problems.push(problem);
    details.push({
      text: problem,
      artifact: p.artifact === undefined || opts.withArtifacts === false ? null : p.artifact(c),
    });
  }

  const skip = problems.length === 0 && stage.skipIf !== null ? stage.skipIf(c) : null;
  return { ok: problems.length === 0, problems, details, skip };
}
