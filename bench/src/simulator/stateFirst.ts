import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RunEvent } from '@sdlc-runner/shared';
import { runBench } from '../driver.ts';
import { makeProject, makeRun, GATES, TEMPLATES, INTENT_REPLIES, PLAN_REPLIES, CHUNK_REPLIES } from './fullFlowFixture.ts';
import { scriptedModel } from './fullFlow.ts';
import type { SimulationCaseResult } from './taskLoop.ts';
import { readCanonicalState } from '../../../server/src/run/canonicalState.ts';
import { readRunVerdict } from '../../../server/src/run/verdictStore.ts';
import { ACCEPTANCE_GATE, acceptanceFresh, independentAcceptanceReport } from '../../../server/src/run/independentAcceptance.ts';

export async function runStateFirstScenarios(image: string): Promise<SimulationCaseResult[]> {
  const results: SimulationCaseResult[] = [];
  for (const mode of ['success', 'wrong-code', 'early-exit', 'protected-suite', 'restart', 'stale-code', 'corrupt-state'] as const) {
    const checks: string[] = [], errors: string[] = [], trace: unknown[] = [];
    const check = (value: unknown, message: string) => { (value ? checks : errors).push(message); };
    const root = makeProject(GATES, true, {
      'methodology/templates/verification-report.template.md': TEMPLATES['verification-report.template.md']! + '- **По каким условиям упал:** н/п\n',
    });
    const suite = mkdtempSync(join(tmpdir(), 'sdlc-independent-tests-'));
    writeFileSync(join(suite, 'contract.test.mjs'), "import test from 'node:test';import assert from 'node:assert/strict';const {version}=await import(process.env.SDLC_CANDIDATE_ROOT+'/src/app.js');test('public version',()=>assert.equal(version,2));\n");
    const review = { schema_version: 'agent-sdlc/verify-review/v1', claims: [{ id: 'claim-1', status: 'passed', evidence: [{ path: 'src/app.js', anchor: 'version' }], remediation: '' }], findings: [], scope: [], invariants: [], regressions: [], retry_instruction: '' };
    const chunk = CHUNK_REPLIES();
    if (mode === 'wrong-code') chunk[0] = { tool: 'Write', args: { file_path: 'src/app.js', content: 'export const version = 3;\n' } };
    if (mode === 'early-exit') chunk[0] = { tool: 'Write', args: { file_path: 'src/app.js', content: 'process.exit(0);export const version=2;\n' } };
    if (mode === 'protected-suite') chunk[0] = { tool: 'Write', args: { file_path: 'src/app.js', content: "import fs from 'node:fs';fs.writeFileSync('/checks/contract.test.mjs','');export const version=2;\n" } };
    const model = await scriptedModel({ intent: INTENT_REPLIES(), plan: PLAN_REPLIES(), chunk, verify: [{ text: JSON.stringify(review) }],
      handoff: [{ tool: 'Write', args: { file_path: '.sdlc/demo/handoff.md', content: '# Передача: demo\n\n- **Приёмка:** ‹подпись и дата›\n\n## Итог\n\nНезависимая приёмка пройдена.\n' } }, { text: 'Передано' }] }, root);
    const events: RunEvent[] = [];
    let run = makeRun(root, model.baseUrl, events);
    let actual = 'not started';
    const base = { run, stageTimeoutMs: 60_000, runTimeoutMs: 120_000, attempts: 1, preparationVersion: 1 as const };
    try {
      run.enableStateFirst();
      const planned = await runBench({ ...base, run, stopAfterStage: 'plan' });
      trace.push({ phase: 'plan', result: planned });
      check(planned.stopped === 'snapshot-point', 'План подготовлен и одобрен до кода');
      check(run.blockers('chunk').some(p => p.includes('приёмка')), 'Без независимого набора Chunk заблокирован');
      const registered = await run.registerIndependentAcceptance({ sourceDir: suite, image, author: { kind: 'human', id: 'Independent fixture author' }, qualification: 'Prepared from the approved contract before candidate implementation', checks: [{ claimId: 'claim-1', file: 'contract.test.mjs', name: 'public version' }], limitations: 'Node built-in modules only' });
      check(!registered.baselinePassed, 'Независимый тест обнаруживает исходное отсутствие нового поведения');
      const implemented = await runBench({ ...base, run, startStage: 'chunk', stopAfterStage: 'chunk' });
      trace.push({ phase: 'chunk', result: implemented });
      check(implemented.stopped === 'snapshot-point', 'Chunk выполняет настоящую правку через политику');
      if (mode === 'restart') { await run.dispose(); run = makeRun(root, model.baseUrl, events); check(readCanonicalState(run.paths)?.state.decisions.some(d => d.kind === 'plan:approval'), 'После рестарта восстановлено решение человека'); }
      if (mode === 'corrupt-state') {
        writeFileSync(join(run.paths.dir, 'state.json'), '{');
        const calls = model.trace.length;
        const verify = await run.runStage('verify');
        actual = verify.note ?? '';
        check(!verify.ok && readRunVerdict(run.paths, 1, 1) === null, 'Повреждённый state блокирует этап без возврата к Markdown');
        check(model.trace.length === calls, 'При порче состояния модель не вызывается');
      } else {
        const verified = await runBench({ ...base, run, startStage: 'verify', stopAfterStage: 'verify', stopAfterVerify: true });
        trace.push({ phase: 'verify', result: verified });
        const accepted = readRunVerdict(run.paths, 1, 1);
        actual = accepted?.passed ? 'accepted' : 'rejected';
        const expected = mode !== 'wrong-code' && mode !== 'protected-suite' && mode !== 'early-exit';
        check(accepted?.passed === expected, expected ? 'Положительный контроль принят по каноническому состоянию' : 'Красная независимая приёмка не перекрашивается модельным PASS');
        check(run.gateResults.some(g => g.name === ACCEPTANCE_GATE && g.status === (expected ? '✅' : '❌')), 'Исход отдельного исполнителя включён в гейты');
        check(independentAcceptanceReport(run.paths, 1, 1)?.includes(expected ? 'PASS' : 'FAIL'), 'Форма независимой приёмки отражает подтверждённый исход исполнителя');
        trace.push({ canonical: run.canonicalState(), acceptanceFresh: acceptanceFresh(run.paths, 1, 1) });
        if (mode === 'stale-code') {
          writeFileSync(join(root, 'src/app.js'), 'export const version=9;\n');
          check(readRunVerdict(run.paths, 1, 1)?.passed === false, 'Правка кода инвалидирует проверку без доверия к старому отчёту');
          check(independentAcceptanceReport(run.paths, 1, 1) === null, 'Устаревшие свидетельства не заполняют новую форму приёмки');
          check(run.blockers('handoff').length > 0, 'Handoff блокирует устаревший результат');
        } else if (expected) {
          writeFileSync(run.paths.verificationReport(1, 1), '# Устаревшая проекция\n- **passed:** false\n');
          check(readRunVerdict(run.paths, 1, 1)?.passed, 'Markdown-проекция не меняет канонический вердикт');
          const handed = await runBench({ ...base, run, startStage: 'handoff' });
          trace.push({ phase: 'handoff', result: handed });
          check(handed.stopped === 'handoff', 'Основной Run завершает handoff после независимой приёмки');
          check(readCanonicalState(run.paths)?.state.stage === 'handoff', 'Каноническое состояние отражает передачу');
        }
      }
    } catch (error) { errors.push(String(error)); }
    finally {
      try { await run.dispose(); await model.close(); }
      finally { trace.push(...model.trace, ...events); errors.push(...model.errors); rmSync(root, { recursive: true, force: true }); rmSync(suite, { recursive: true, force: true }); }
    }
    results.push({ id: `state-first-${mode}`, passed: errors.length === 0, expected: 'Канонический state и независимая изолированная приёмка', actual, checks, errors, trace });
  }
  return results;
}
