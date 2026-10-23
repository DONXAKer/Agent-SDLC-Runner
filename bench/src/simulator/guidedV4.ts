/** Full current guided protocol using pinned methodology forms and a bounded model double. */
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { cpSync, readFileSync, writeFileSync, rmSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import type { RunEvent } from '@sdlc-runner/shared';
import { runBench } from '../driver.ts';
import { makeProject, makeRun, GATES } from './fullFlowFixture.ts';
import type { SimulationCaseResult } from './taskLoop.ts';

const requirement = `# Public revision
Full preparation and investigation are required.
## Expected behavior
1. Change version in src/app.js to the numeric value 2.
2. Preserve the label export in src/app.js with value stable.
3. Add test/revision.test.mjs using node:test to assert version and label.
4. Run the project checks and record their actual outcome.
5. Keep existing tests and other implementation files unchanged.
`;
const claims = ['claim-1', 'claim-2', 'claim-3', 'claim-4', 'claim-5'];
const testSource = "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport {version,label} from '../src/app.js';\ntest('revision contract',()=>{assert.equal(version,2);assert.equal(label,'stable')});\n";
const fixtureDir = fileURLToPath(new URL('../../fixtures/guided-process/', import.meta.url));
type Mode = 'happy' | 'repair' | 'wrong-code' | 'resume' | 'repeated-op' | 'manual-claim' | 'unfounded-rejection' | 'guided-protected' | 'guided-restart' | 'guided-stale' | 'guided-red-acceptance';

async function scenario(mode: Mode, image: string, engineVersion: 4 | 5 = 4): Promise<SimulationCaseResult> {
  const checks: string[] = [], errors: string[] = [], events: RunEvent[] = [];
  const trace: unknown[] = [{ kind: 'profile', preparationVersion: 3, executionMode: 'guided', guidedEngineVersion: engineVersion,
    contour: 'full', templates: JSON.parse(readFileSync(join(fixtureDir, 'templates.json'), 'utf8')) }];
  const check = (value: unknown, message: string) => (value ? checks : errors).push(message);
  const root = makeProject(GATES.replaceAll('`node --version`', '`node tools/check.cjs`'), true, {
    'src/app.js': "export const version = 1;\nexport const label = 'stable';\n",
    'package.json': '{"type":"module"}\n',
    'test/existing.test.mjs': "import test from 'node:test';import assert from 'node:assert/strict';import {label} from '../src/app.js';test('existing label',()=>assert.equal(label,'stable'));\n",
    // Prepared before any candidate; this expectation is never inferred from a model response.
    'tools/check.cjs': "const assert=require('node:assert/strict');const fs=require('node:fs');const cp=require('node:child_process');import('../src/app.js').then(m=>{assert.equal(m.version,2);assert.equal(m.label,'stable');assert.ok(fs.existsSync('test/revision.test.mjs'));const env={...process.env};delete env.NODE_TEST_CONTEXT;const p=cp.spawnSync(process.execPath,['--test','test/existing.test.mjs','test/revision.test.mjs'],{encoding:'utf8',env});process.stdout.write(p.stdout||'');process.stderr.write(p.stderr||'');if(p.error)throw p.error;process.exitCode=p.status??1}).catch(e=>{console.error(e);process.exitCode=1});\n",
  });
  cpSync(join(fixtureDir, 'templates'), join(root, 'methodology/templates'), { recursive: true });
  const protectedTest = readFileSync(join(root, 'test/existing.test.mjs'), 'utf8');
  const initialCode = readFileSync(join(root, 'src/app.js'), 'utf8');
  const suite = mkdtempSync(join(tmpdir(), 'guided-v4-independent-'));
  const acceptanceNames = ['public revision', 'stable label', 'new test', 'executable test', 'preserved test'];
  writeFileSync(join(suite, 'contract.test.mjs'), `import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';
const root=process.env.SDLC_CANDIDATE_ROOT;const load=()=>import(root+'/src/app.js');
test('public revision',async()=>assert.equal((await load()).version,2));
test('stable label',async()=>assert.equal((await load()).label,'stable'));
test('new test',()=>assert.ok(fs.existsSync(root+'/test/revision.test.mjs')));
test('executable test',()=>assert.match(fs.readFileSync(root+'/test/revision.test.mjs','utf8'),/node:test/));
test('preserved test',()=>assert.equal(fs.readFileSync(root+'/test/existing.test.mjs','utf8'),${JSON.stringify(protectedTest)}));\n`);
  let calls = 0, injected = false, askCalls = 0, rejectedDrafts = 0, manualReplies = 0;
  const answer = (request: any): unknown => {
    if (++calls > 120) throw new Error('Guided script request budget exhausted');
    const format = request.response_format?.json_schema;
    const schema = format?.schema;
    let user = request.messages.findLast((m: any) => m.role === 'user')?.content ?? '';
    let packet:any; try { packet=JSON.parse(user); } catch { packet={}; }
    if (engineVersion === 5 && packet.decisionId) {
      check(request.messages.length === 2 && request.messages.every((m:any)=>['system','user'].includes(m.role)), 'Every v5 model call has no conversation history');
      const questions = packet.question;
      user = typeof questions[0] === 'string' ? questions[0] : JSON.stringify(questions[0]);
    }
    let input: any;
    try { input = JSON.parse(user); } catch { input = {}; }
    const name = format?.name;
    if (mode === 'repair' && !injected && name === 'sdlc_form_fields') { injected = true; return '{broken'; }
    if (name === 'sdlc_form_fields') {
      const values: Record<string, string> = {};
      for (const [key, value] of Object.entries(schema.properties) as [string, any][]) {
        values[key] = value.enum?.includes('полный') ? 'полный' : value.enum?.[0] ??
          (/чего не делаем/iu.test(input.question ?? '') ? 'Существующие тесты и другие исходники остаются без правок.' :
            /что делаем/iu.test(input.question ?? '') ? 'Изменить version в src/app.js; добавить test/revision.test.mjs, сохранить label.' :
              /контур/iu.test(input.question ?? '') ? 'полный' :
                'Изменить version в src/app.js до 2 и проверить сохранение label тестом test/revision.test.mjs.');
      }
      return values;
    }
    if (name === 'guided_field_items') return { items: ['Существующие тесты и другие исходники остаются без правок.'] };
    if (name === 'preparation_claims') {
      const basis = schema.items.oneOf?.[0]?.properties?.basis;
      return claims.map((id, index) => basis
        ? { id, basis: { file: 'request-1', lines: [index + 4, index + 4] }, scenario: 'Check the requested contract', counterexample: 'A changed value or missing check fails' }
        : { id, procedure: 'Run node tools/check.cjs and inspect its exit status and contract assertions', expected: 'version is 2, label is stable, added tests execute successfully and existing tests are unchanged' });
    }
    if (name === 'intent_claim_review' || name === 'intent_contract_review') return { issues: [] };
    if (name === 'preparation_review_scenarios') return { scenarios: [{ scenario: 'Read version and label; execute both test files', incorrectBehavior: 'version differs from 2, label changes, or a test is missing', basis: 'Numbered source requirements 1 through 5' }] };
    if (name === 'preparation_review_issues') return { issues: [] };
    if (name === 'guided_review') return { findings: [] };
    if (name === 'intent_issue_adjudication') return { relation: 'compatible', condition: 'Requested revision', explanation: 'The requirement explicitly changes version and preserves label.', witness: 'Changing version while leaving label stable satisfies both requirements.' };
    if (name === 'guided_claim') {
      if (mode === 'unfounded-rejection' && manualReplies++ === 0) return { status: '❌', evidence: 'src/app.js:version', fix: '' };
      if (mode === 'manual-claim' && manualReplies++ === 0) return { status: 'manual', evidence: 'src/app.js:version', fix: 'Inspect the exported value' };
      return { status: '✅', evidence: 'src/app.js:version; test/revision.test.mjs:revision contract', fix: '' };
    }
    if (name === 'guided_failure_diagnosis') return { kind: 'implementation', reason: 'Observed version differs from the requested numeric value', observedFailure: '3 !== 2', source: { request: 1, lines: [4, 4] } };
    if (name === 'guided_file_research') return { fact: 'Source read; version and label are exported from src/app.js.',
      impact: 'Update version and preserve label; add a separate executable test.',
      change: input.source.path === 'src/app.js' ? 'Update version to 2; keep label stable.' : null,
      reuse: null, risks: [], questions: input.source.path === 'src/app.js' ? [{ question: 'Какое значение version требуется в src/app.js?', blocking: true }] : [] };
    if (name === 'guided_question_resolution') { askCalls++; return { kind: 'source', source: 'request-1', lines: [4, 4], answer: 'version в src/app.js должен быть числом 2.' }; }
    if (name === 'guided_implementation_plan' || name === 'guided_compact_plan') return {
      approach: 'Изменить существующий version в src/app.js, сохранив label. test/existing.test.mjs показывает node:test; добавить отдельный test/revision.test.mjs.',
      steps: [{ file: 'src/app.js', symbol: 'version', action: 'Изменить version на 2, сохранить label', claims: ['claim-1', 'claim-2'], check: 'node tools/check.cjs', expected: 'version equals 2 and label is stable', contract: 'Изменяется значение version, label сохранён', dependsOn: [] },
        { file: 'test/revision.test.mjs', symbol: { isNew: true, name: 'revisionContract' }, action: 'Добавить тесты version и label через node:test', claims, check: 'node tools/check.cjs', expected: 'all contract checks pass and existing tests stay unchanged', contract: 'Новый тест; публичный API не меняется', dependsOn: [1] }],
      excluded: ['Существующие тесты и другие исходники не менять'],
      axes: Array.from({ length: 6 }, (_, i) => ({ affected: i === 4, reason: 'Проверяется числовой экспорт и сохранение label', outcome: 'claim-1, claim-2, claim-3, claim-4, claim-5' })),
      changes: 'Требования сохранены', callers: (input.callerFacts ?? []).flatMap((f: any) => f.callers.map(() => ({ decision: 'Потребитель label сохраняет прежнее значение и не требует правки.' }))),
    };
    if (input.questionId?.startsWith('chunk:')) {
      if (input.targetFile === 'test/revision.test.mjs') return { action: 'patch', prediction: 'New executable contract test', ops: [{ op: 'create_file', body: testSource }] };
      if (mode === 'repeated-op' && rejectedDrafts < 2) {
        rejectedDrafts++;
        check(readFileSync(join(root, 'src/app.js'), 'utf8') === initialCode, 'Rejected drafts never reach the working tree');
        return { action: 'patch', prediction: 'incorrect owner', ops: [{ op: 'replace_body', body: 'export function unrelated() { return 2; }' }] };
      }
      if (mode === 'repeated-op') check(engineVersion === 5 ? !!packet.recovery : /Адресный ремонт/u.test(input.feedback ?? ''), 'Repeated invalid operation receives a narrowed repair request');
      if(engineVersion===5){
        const file=input.files.find((f:any)=>f.path==='src/app.js');
        const target=file.targets.find((t:any)=>t.symbol==='version');
        return {action:'patch',prediction:'version equals the required value',ops:[{op:'replace_declaration',symbol:'version',expectedHash:file.hash,targetId:target.targetId,declaration:`export const version = ${mode === 'wrong-code' ? 3 : 2};`}]};
      }
      return { action: 'patch', prediction: 'version equals the required value', ops: [{ op: 'replace_body', body: `export const version = ${mode === 'wrong-code' ? 3 : 2};` }] };
    }
    throw new Error(`Unhandled guided fixture request: ${name}; ${String(input.questionId)}; ${String(user).slice(0, 400)}`);
  };
  const server = createServer((req, res) => {
    let body = ''; req.on('data', part => { body += part; });
    req.on('end', () => {
      let request: unknown;
      try {
        request = JSON.parse(body); const value = answer(request);
        trace.push({ kind: 'scripted_reply', request, response: value });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ index: 0, message: { role: 'assistant', content: typeof value === 'string' ? value : JSON.stringify(value) }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 10 } }));
      } catch (error) {
        errors.push(String(error)); trace.push({ request, error: String(error) });
        res.writeHead(400, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { message: String(error) } }));
      }
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const make = () => makeRun(root, url, events, { contextWindow: 32768 }, [], { guided: true, engineVersion });
  let run = make(); let actual = 'not started';
  const base = { stageTimeoutMs: 30000, runTimeoutMs: 120000, attempts: 1, preparationVersion: 3 as const, executionMode: 'guided' as const, guidedEngineVersion: engineVersion, requirement };
  try {
    const protectedGuided = mode.startsWith('guided-');
    if (!protectedGuided && engineVersion === 4) run.enableStateFirst();
    const planned = await runBench({ ...base, run, stopAfterStage: 'plan' });
    trace.push({ phase: 'preparation', result: planned });
    check(planned.stopped === 'snapshot-point', 'Current guided v4 preparation completes through approved Plan');
    if (planned.stopped !== 'snapshot-point') throw new Error(JSON.stringify(planned.stages));
    if (protectedGuided) {
      const blocked = await run.runStage('chunk');
      check(!blocked.ok && readFileSync(join(root, 'src/app.js'), 'utf8') === initialCode, 'Missing protected suite stops Guided before implementation');
    }
    check(askCalls > 0, 'Ask resolves an actual candidate through a source citation');
    const registered = await run.registerIndependentAcceptance({ sourceDir: suite, image,
      author: { kind: 'human', id: 'Independent simulator fixture author' },
      qualification: 'Named expected behavior prepared before candidate code; baseline and immutable Docker suite',
      checks: claims.map((claimId, i) => ({ claimId, file: 'contract.test.mjs', name: acceptanceNames[i]! })),
      limitations: 'Finite Node cases; model review does not establish reliability for unseen tasks' });
    trace.push({ kind: 'independent-baseline', result: registered });
    check(!registered.baselinePassed, 'Independent acceptance rejects the original implementation before any mutation');
    if (mode === 'resume' || mode === 'guided-restart') { const before = calls; await run.dispose(); run = make(); trace.push({ kind: 'restart', modelCalls: before }); }
    const implemented = await runBench({ ...base, run, startStage: 'chunk', stopAfterStage: 'chunk' });
    trace.push({ phase: 'implementation', result: implemented }); actual = implemented.stopped;
    if (mode === 'wrong-code') {
      check(implemented.stopped !== 'snapshot-point', 'Incorrect implementation cannot pass the independently prepared checks');
      check(readFileSync(join(root, 'src/app.js'), 'utf8') === initialCode, 'Rejected implementation is rolled back');
      check(!run.lastVerdict?.passed, 'Incorrect code has no positive verdict');
    } else {
      check(implemented.stopped === 'snapshot-point', 'Guided implementation passes real subprocess checks');
      if (implemented.stopped !== 'snapshot-point') throw new Error(JSON.stringify(implemented.stages));
      // Remaining verification and handoff responses are filled below by the same protocol double.
      if (mode === 'guided-red-acceptance') writeFileSync(join(root,'src/app.js'),"export const version=3;export const label='stable';\n");
      const finished = await runBench({ ...base, run, startStage: 'verify', ...(mode === 'guided-stale' ? { stopAfterStage: 'verify' as const, stopAfterVerify: true } : {}) });
      trace.push({ phase: 'completion', result: finished }); actual = finished.stopped;
      if (mode === 'guided-red-acceptance') {
        check(!finished.finalVerdict?.passed && finished.stopped !== 'handoff', 'Red independent acceptance cannot be overwritten by model PASS');
      } else if (mode === 'guided-stale') {
        const { readRunVerdict } = await import('../../../server/src/run/verdictStore.ts');
        check(readRunVerdict(run.paths,1,1)?.passed, 'Protected Guided produces an accepted result before mutation');
        writeFileSync(join(root,'src/app.js'),"export const version=9;export const label='stable';\n");
        check(readRunVerdict(run.paths,1,1)?.passed === false, 'Changed code invalidates the stored Guided verdict');
        check(run.blockers('handoff').length>0, 'Handoff stays blocked until a fresh acceptance run');
      } else check(finished.stopped === 'handoff' && finished.finalVerdict?.passed,
        `Verify and Handoff finish with a trusted verdict: ${JSON.stringify(finished)}`);
      if (!protectedGuided) check(trace.filter((event: any) => event.kind === 'scripted_reply' && event.request.response_format?.json_schema?.name === 'guided_claim')
        .every((event: any) => event.request.model === 'scripted-reviewer'), 'Canonical claim judgments come from the independent reviewer, never the writer');
    }
    check(readFileSync(join(root, 'test/existing.test.mjs'), 'utf8') === protectedTest, 'Existing tests stay byte-for-byte unchanged');
    if (mode === 'repair') check(injected && events.some(e => e.type === 'question_validation' && !e.accepted), 'Malformed field response is rejected before a valid repair');
    if (mode === 'repeated-op') check(rejectedDrafts === 2, 'Two rejected proposals are followed by a corrected bounded proposal');
    if (mode === 'manual-claim') check(manualReplies > 1 && events.some(e => e.type === 'question_validation' && !e.accepted), 'Unsupported manual claim is rejected before verified acceptance');
    if (mode === 'unfounded-rejection') check(manualReplies > 1 && events.some(e => e.type === 'question_validation' && !e.accepted), 'An unsupported negative review is repaired before it can trigger code changes');
  } catch (error) { errors.push(String(error)); }
  finally {
    for (const path of [run.paths.intent, run.paths.plan, run.paths.verificationReport(1, 1), run.paths.handoff]) {
      try { trace.push({ kind: 'artifact', path, text: readFileSync(path, 'utf8') }); } catch { /* stage not reached */ }
    }
    trace.push(...events);
    await run.dispose();
    await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); });
    rmSync(root, { recursive: true, force: true });
    rmSync(suite, { recursive: true, force: true });
  }
  return { id: `guided-v${engineVersion}-${mode}`, expected: mode === 'wrong-code' ? 'Incorrect code rejected' : `Full guided v${engineVersion} reaches trusted handoff`, actual, checks, errors, passed: errors.length === 0, trace };
}

export async function runGuidedV4Scenarios(image: string, modes: readonly Mode[] = ['happy', 'repair', 'wrong-code', 'resume', 'repeated-op', 'manual-claim', 'unfounded-rejection', 'guided-protected', 'guided-restart', 'guided-stale', 'guided-red-acceptance'], engineVersion: 4 | 5 = 4): Promise<SimulationCaseResult[]> {
  if (!image) throw new Error('guided-v4-full-flow requires an explicit local Docker image');
  const results: SimulationCaseResult[] = [];
  for (const mode of modes) results.push(await scenario(mode, image, engineVersion));
  return results;
}
