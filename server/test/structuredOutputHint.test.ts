import test from 'node:test';
import assert from 'node:assert/strict';
import { structuredOutputHint } from '../src/provider/structuredOutputHint.ts';

test('schema grounding derives literal choices from arbitrary nested schemas', () => {
  const hint = structuredOutputHint({ type: 'json_schema', json_schema: { schema: { properties: { mode: { enum: ['retain', 'remove'] }, edits: { type: 'array', items: { properties: { op: { const: 'replace' } } } } } } } });
  assert.ok(hint?.includes('$.mode'));
  assert.ok(hint?.includes('$.edits[].op'));
  assert.ok(hint?.includes('retain'));
  assert.equal(structuredOutputHint({ type: 'json_object' }), null);
  assert.equal(structuredOutputHint({ type: 'json_schema', json_schema: { schema: { type: 'string' } } }), null);
});

test('grounding is bounded and marks omitted hints without truncating literal values', () => {
  const hint = structuredOutputHint({ type: 'json_schema', json_schema: { schema: { properties: { short: { enum: ['on', 'off'] }, large: { enum: ['x'.repeat(5000)] } } } } });
  assert.ok(hint);
  assert.ok(Buffer.byteLength(hint) <= 2048);
  assert.ok(hint.includes('Some literal constraints are omitted'));
  assert.ok(!hint.includes('$.large'));
});

test('constraints never introduce a competing JSON object that can be copied as the answer', () => {
  const hint = structuredOutputHint({ type: 'json_schema', json_schema: { schema: { properties: { action: { enum: ['keep', 'change'] } } } } });
  assert.ok(hint?.includes('$.action must use one of these JSON literals: "keep", "change"'));
  assert.ok(hint?.includes('Do not output this list'));
  assert.ok(!hint?.includes('"choices"'));
  assert.throws(() => JSON.parse(hint!));
});

test('conditional alternatives never become unconditional conflicting constraints',()=>{
 const hint=structuredOutputHint({type:'json_schema',json_schema:{schema:{oneOf:[{properties:{kind:{const:'source'},source:{const:'lib/one.ts'}}},{properties:{kind:{const:'context'},source:{const:'lib/two.ts'}}}]}}});
 assert.equal(hint,null);
});
