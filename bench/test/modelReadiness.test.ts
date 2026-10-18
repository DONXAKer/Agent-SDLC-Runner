import { strictEqual } from 'node:assert/strict';
import { it } from 'node:test';
import { STAGE_ORDER } from '@sdlc-runner/shared';
import { modelReadiness, RECOVERY_TASKS } from '../src/modelReadiness.ts';

it('готовность требует все повторы, оценки и пять полных задач на одинаковых условиях', () => {
  const model = 'ollama:test';
  const passport = { sourceHash: 'source-with-prompts', configHash: 'profile', inputHash: 'input', localEndpoints: { ollama: 'http://localhost:11435/v1' } };
  const raw = { run: { model, routes: Object.fromEntries(STAGE_ORDER.map((s) => [s, model])), mode: { kind: 'all' } },
    diagnostics: { state: 'finished', passport }, finalVerdict: { passed: true }, hidden: { fail: 0 },
    driver: { stages: STAGE_ORDER.map((stage) => ({ stage, ok: true })) } };
  const ids = Array.from({ length: 15 }, (_, i) => `case-${i}`);
  const args = { model, currentInputs: 15, expectedCases: ids, currentSourceHash: 'source',
    report: { fingerprint: { sourceHash: 'source' }, repeats: 5, preflight: { exitCode: 0 } },
    results: ids.flatMap((caseId) => Array.from({ length: 5 }, () => ({ caseId, raw: structuredClone(raw), accepted: true, problems: [] as string[] }))),
    cycles: RECOVERY_TASKS.map((task) => ({ raw: { ...structuredClone(raw), run: { ...raw.run, task } }, accepted: true })) };
  strictEqual(modelReadiness(args).ready, true);
  const noQuestionAsk = args.cycles.find((cycle) => cycle.raw.run.task === 'two-right-answers')!.raw.driver.stages.find((s) => s.stage === 'ask')! as
    { stage: string; ok: boolean; skipped?: boolean; note?: string };
  Object.assign(noQuestionAsk, { skipped: true, note: 'открытых вопросов нет — этап условный, артефакт не создаётся' });
  strictEqual(modelReadiness(args).ready, true);
  noQuestionAsk.note = 'мелкий контур: этап не запускается';
  strictEqual(modelReadiness(args).ready, false);
  noQuestionAsk.note = 'открытых вопросов нет — этап условный, артефакт не создаётся';
  args.results[0]!.accepted = false;
  strictEqual(modelReadiness(args).ready, false);
  args.results[0]!.accepted = true;
  args.cycles.pop();
  strictEqual(modelReadiness(args).cyclesPassed, 4);
  strictEqual(modelReadiness(args).ready, false);
  args.results[0]!.raw.diagnostics.passport.configHash = 'other-profile';
  strictEqual(modelReadiness(args).diagnosticsPassed, false);
});
