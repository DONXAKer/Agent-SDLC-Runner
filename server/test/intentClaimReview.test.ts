import { deepStrictEqual, equal, throws, ok } from 'node:assert/strict';
import { test } from 'node:test';
import { intentClaimReviewProblems, intentClaimSourceFacts } from '../src/exec/intentClaimReview.ts';

test('claim grounding uses only named public code and bounded head/tail previews', () => {
  const facts = intentClaimSourceFacts([
    { path: 'src/data.ts', kind: 'code', text: 'actual sku AZ-123\n' + 'x'.repeat(8000) + '\nactual tail' },
    { path: 'test/hidden.test.ts', kind: 'test', text: 'hidden solution' },
    { path: 'src/unrequested.ts', kind: 'code', text: 'not requested' },
  ], 'Read src/data.ts and test/hidden.test.ts');
  equal(facts.length, 1); equal(facts[0]?.path, 'src/data.ts'); equal(facts[0]?.truncated, true);
  ok(facts[0]?.content.startsWith('actual sku AZ-123')); ok(facts[0]?.content.endsWith('actual tail'));
  ok(facts[0]!.content.length < 4050);
});
test('ambiguous basename is not guessed', () => {
  deepStrictEqual(intentClaimSourceFacts(['a/data.ts', 'b/data.ts'].map(path => ({path,kind:'code',text:'data'})), 'data.ts'), []);
});
test('claim review must complete a closed schema with known IDs and actual reasons', () => {
  deepStrictEqual(intentClaimReviewProblems('{"issues":[]}', ['claim-1']), []);
  const issue = {claimId:'claim-1',problem:'wrong expectation',basis:'valid input allowed',counterexample:'valid input refused'};
  equal(intentClaimReviewProblems(JSON.stringify({issues:[issue]}), ['claim-1']).length, 1);
  throws(() => intentClaimReviewProblems(JSON.stringify({issues:[{...issue,claimId:'claim-99'}]}), ['claim-1']));
  throws(() => intentClaimReviewProblems('{"issues":[],"approved":true}', ['claim-1']));
  throws(() => intentClaimReviewProblems('', ['claim-1']));
});

test('claim review accepts compound claimId lists from the model', () => {
  const issue = { claimId: 'claim-2, claim-3', problem: 'shared gap', basis: 'request', counterexample: 'input X' };
  const problems = intentClaimReviewProblems(JSON.stringify({ issues: [issue] }), ['claim-1', 'claim-2', 'claim-3']);
  equal(problems.length, 2);
  ok(problems[0]!.startsWith('claim-2:'));
  ok(problems[1]!.startsWith('claim-3:'));
  throws(() => intentClaimReviewProblems(JSON.stringify({ issues: [{ ...issue, claimId: 'claim-2, claim-99' }] }),
    ['claim-1', 'claim-2', 'claim-3']));
});
