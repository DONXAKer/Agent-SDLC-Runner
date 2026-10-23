import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { WitokPaths } from '../src/artifacts/paths.ts';
import { initGuided } from '../src/run/guidedState.ts';
import { guidedAcceptanceProblem } from '../src/run/guidedAcceptance.ts';
import { acceptanceFresh, acceptanceProblem, registerAcceptance, runIndependentAcceptance, independentAcceptanceReport } from '../src/run/independentAcceptance.ts';
import { readRunVerdict, writeRunVerdict } from '../src/run/verdictStore.ts';
import { execFileSync } from 'node:child_process';
import { chunkModule } from '../src/run/stages/chunk/index.ts';
import { verifyModule } from '../src/run/stages/verify/index.ts';
import type { StageHost } from '../src/run/stages/types.ts';
import type { ResolvedRoute } from '../src/config/schema.ts';

test('actual required template blocks guided chunk and verify before sandbox or model calls', async t => {
  const root = mkdtempSync(join(tmpdir(), 'guided-acceptance-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const paths = new WitokPaths(root, 'case');
  initGuided(paths, 'test', 4);
  mkdirSync(join(root, 'templates'));
  const template = readFileSync(new URL('../../bench/fixtures/guided-process/templates/verification-report.template.md', import.meta.url), 'utf8');
  writeFileSync(join(root, 'templates', 'verification-report.template.md'), template);
  const host = { paths, runner: () => ({ methodologyDir: root }), chunk: () => 1, attempt: () => 1 } as unknown as StageHost;
  for (const stage of [chunkModule, verifyModule]) {
    const blocker = await stage.begin!(host, {} as ResolvedRoute).entryBlocker!();
    assert.match(blocker ?? '', /приёмка не зафиксирована/);
  }
  assert.equal(readFileSync(join(root, 'templates', 'verification-report.template.md'), 'utf8'), template);
});

test('old templates remain supported; a required section in an existing report is also checked', t => {
  const root = mkdtempSync(join(tmpdir(), 'guided-acceptance-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const paths = new WitokPaths(root, 'case');
  mkdirSync(paths.dir, { recursive: true });
  assert.equal(guidedAcceptanceProblem(paths, root, 2, 3), null);
  writeFileSync(paths.verificationReport(2, 3), '# Report\n\n## Независимые приёмочные проверки\n- **Применимость:** ‹основание›\n');
  initGuided(paths, 'test', 4);
  assert.match(guidedAcceptanceProblem(paths, root, 2, 3) ?? '', /приёмка не зафиксирована/);
});

test('guided protected acceptance blocks missing suites, survives restart and rejects failures, stale code and altered contracts',
  { skip: !process.env.SDLC_TEST_DOCKER_IMAGE }, async t => {
  const root=mkdtempSync(join(tmpdir(),'guided-acceptance-flow-')), suite=mkdtempSync(join(tmpdir(),'independent-suite-'));
  t.after(()=>{rmSync(root,{recursive:true,force:true});rmSync(suite,{recursive:true,force:true});});
  execFileSync('git',['init','-q'],{cwd:root});
  const paths=new WitokPaths(root,'repair');initGuided(paths,'test',4);
  writeFileSync(paths.intent,'# Contract\n\n| id | Пункт | Как проверить |\n|---|---|---|\n| claim-1 | Preserve signed multiplication | Multiply positive and negative inputs |\n');
  writeFileSync(paths.plan,'# Plan\n\n- **Одобрение:** Operator, 2026-10-20\n');
  writeFileSync(join(root,'multiply.mjs'),'export const multiply=(a,b)=>a+b;\n');
  writeFileSync(join(suite,'contract.test.mjs'),"import test from 'node:test';import assert from 'node:assert/strict';const {multiply}=await import(process.env.SDLC_CANDIDATE_ROOT+'/multiply.mjs');test('signed multiplication',()=>{assert.equal(multiply(3,4),12);assert.equal(multiply(-3,4),-12);});\n");
  assert.notEqual(acceptanceProblem(paths),null);
  const input={sourceDir:suite,image:process.env.SDLC_TEST_DOCKER_IMAGE!,author:{kind:'model',id:'independent-reviewer'},qualification:'Prepared from contract',checks:[{claimId:'claim-1',file:'contract.test.mjs',name:'signed multiplication'}],limitations:'Pure Node module fixture'};
  await assert.rejects(registerAcceptance(paths,{...input,author:{kind:'model',id:'test'}},'Operator','test'),/Автор реализации/);
  const frozen=await registerAcceptance(paths,input,'Operator','test');assert.equal(frozen.baselinePassed,false);
  assert.equal((await runIndependentAcceptance(paths,1,1)).status,'❌');
  writeRunVerdict(paths,1,1,{passed:true,action:'continue',reasons:[]});
  assert.equal(readRunVerdict(paths,1,1)?.passed,false,'a forged green cannot bypass red acceptance');
  writeFileSync(join(root,'multiply.mjs'),'export const multiply=(a,b)=>a*b;\n');
  assert.equal((await runIndependentAcceptance(paths,1,2)).status,'✅');
  const restored=new WitokPaths(root,'repair');assert.equal(acceptanceProblem(restored),null);
  assert.equal(acceptanceFresh(restored,1,2),true);
  assert.match(independentAcceptanceReport(restored,1,2)??'',/PASS/);
  writeRunVerdict(restored,1,2,{passed:true,action:'continue',reasons:[]});assert.equal(readRunVerdict(restored,1,2)?.passed,true);
  writeFileSync(join(root,'multiply.mjs'),'export const multiply=()=>0;\n');
  assert.equal(acceptanceFresh(restored,1,2),false);assert.equal(readRunVerdict(restored,1,2)?.passed,false);
  assert.equal(independentAcceptanceReport(restored,1,2),null);
  writeFileSync(paths.intent,readFileSync(paths.intent,'utf8').replace('signed multiplication','division'));
  assert.match(acceptanceProblem(paths)??'',/Требования или план изменились/);
});
