import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { emptyUsage } from '@sdlc-runner/shared';
import { z } from 'zod';
import { TypedPatchOp } from '../src/exec/implementationIr.ts';
import { compileTypedPatch, TypedPatchCompileError } from '../src/exec/typedPatchCompiler.ts';
import { applySymbolOp, declarationId, findSymbols, GuidedOpError } from '../src/exec/symbolOps.ts';
import { guidedActionResponseFormat, guidedBoundActionResponseFormat, parseBoundGuidedReply, parseGuidedReply, simulateOps, summarizeReplyError, validateBoundGuidedReplyCandidate, validateGuidedReplyCandidate } from '../src/exec/GuidedExecutor.ts';
import { DecisionEngine, DecisionError, decisionProvider } from '../src/exec/decisionEngine.ts';
import type { ChatProvider } from '../src/provider/ChatProvider.ts';

const id = (name: string) => ({ kind: 'identifier', name });
const literal = (value: string | number | boolean | null) => ({ kind: 'literal', value });
const hash = (source: string) => createHash('sha256').update(source).digest('hex');
const target = (source: string, symbol = 'run') => {
  const declaration = findSymbols(source).find(value => value.qualified === symbol)!;
  return { targetId: declarationId(source, declaration), expectedHash: hash(source) };
};
const compile = (op: unknown) => compileTypedPatch(TypedPatchOp.parse(op));

test('typed compiler is deterministic and creates a complete module', () => {
  const operation = {
    op: 'create_file_ir', file: 'src/math.ts', module: { version: 1, body: [
      { kind: 'import', source: './types.ts', names: [{ imported: 'Input' }], typeOnly: true },
      { kind: 'function_declaration', name: 'sum', export: true, async: false,
        params: [{ name: 'values', type: { kind: 'type', text: 'ReadonlyArray<number>' } }],
        returnType: { kind: 'type', text: 'number' }, body: { kind: 'block', body: [
          { kind: 'return', argument: { kind: 'call', callee: { kind: 'property_access', object: id('values'), property: id('reduce'), computed: false }, arguments: [
            { kind: 'arrow', params: [{ name: 'total' }, { name: 'value' }], body: { kind: 'binary', operator: '+', left: id('total'), right: id('value') } }, literal(0),
          ] } },
        ] } },
      { kind: 'reexport', source: './public.ts', names: [{ imported: 'sum', exported: 'total' }] },
    ] },
  };
  const first = compile(operation);
  const second = compile(JSON.parse(JSON.stringify(operation)));
  assert.deepEqual(first, second);
  assert.equal(first.op, 'create_file');
  assert.match(first.op === 'create_file' ? first.body : '', /export function sum\(values: ReadonlyArray<number>\): number/);
  assert.match(first.op === 'create_file' ? first.body : '', /export \{ sum as total \} from '\.\/public\.ts'/);
  assert.equal(applySymbolOp(null, first), (first.op === 'create_file' ? first.body : '') + '\n');
});

test('function bodies compile arrows and assertion calls without raw source', () => {
  const source = 'export function run() { return 0; }\n';
  const operation = { op: 'replace_function_ir', file: 'test/assert.ts', symbol: 'run', ...target(source), body: [
    { kind: 'variable_declaration', declarationKind: 'const', name: 'check', initializer: {
      kind: 'arrow', params: [{ name: 'actual', type: { kind: 'type', text: 'number' } }], body: { kind: 'block', body: [
        { kind: 'expression_statement', expression: { kind: 'call', callee: { kind: 'property_access', object: id('assert'), property: id('equal'), computed: false },
          arguments: [id('actual'), literal(2)] } },
      ] },
    } },
    { kind: 'expression_statement', expression: { kind: 'call', callee: id('check'), arguments: [literal(2)] } },
    { kind: 'return', argument: { kind: 'conditional', test: id('check'), consequent: literal(true), alternate: literal(false) } },
  ] };
  const raw = compile(operation);
  assert.equal(raw.op, 'replace_function_body');
  assert.match(raw.op === 'replace_function_body' ? raw.body : '', /const check = \(actual: number\) => \{/);
  const after = applySymbolOp(source, raw);
  assert.match(after, /assert\.equal\(actual, 2\)/);
  assert.match(after, /return check \? true : false;/);
});

test('interface and type alias declarations compile without raw declaration text', () => {
  const interfaceSource = "export interface BillingConfig { currency: 'RUB'; }\n";
  const interfaceOp = compile({ op: 'replace_declaration_ir', file: 'src/config.ts', symbol: 'BillingConfig', ...target(interfaceSource, 'BillingConfig'),
    declaration: { kind: 'interface_declaration', name: 'BillingConfig', export: true,
      properties: [{ name: 'currency', type: { kind: 'type', text: "'RUB'" } }, { name: 'defaultDueDays', type: { kind: 'type', text: 'number' } }], methods: [] } });
  assert.match(interfaceOp.op === 'replace_declaration' ? interfaceOp.declaration : '', /export interface BillingConfig/);
  assert.match(applySymbolOp(interfaceSource, interfaceOp), /defaultDueDays: number/);
  const aliasSource = 'export type Result = string;\n';
  const aliasOp = compile({ op: 'replace_declaration_ir', file: 'src/result.ts', symbol: 'Result', ...target(aliasSource, 'Result'),
    declaration: { kind: 'type_alias_declaration', name: 'Result', export: true, type: { kind: 'type', text: 'ReadonlyArray<number>' } } });
  assert.equal(applySymbolOp(aliasSource, aliasOp), 'export type Result = ReadonlyArray<number>;\n');
});

test('TYPE nodes accept types only and unsupported declaration positions fail clearly', () => {
  const source = 'export const run = () => 1;\n';
  assert.throws(() => compile({ op: 'replace_declaration_ir', file: 'a.ts', symbol: 'run', ...target(source),
    declaration: { kind: 'variable_declaration', declarationKind: 'const', name: 'run', type: { kind: 'type', text: 'number; throw new Error()' }, initializer: literal(1) } }),
  (error: unknown) => error instanceof TypedPatchCompileError && /Invalid TYPE node/.test(error.message));
  // Хвостовая `;` — след копирования из объявления, не инъекция: тип принимается (корпус r1–r4, mellum).
  const trailing = compile({ op: 'replace_declaration_ir', file: 'a.ts', symbol: 'run', ...target(source),
    declaration: { kind: 'variable_declaration', declarationKind: 'const', name: 'run', type: { kind: 'type', text: 'Map<string, { id: string; msg: string }>;' }, initializer: literal(1) } });
  assert.match(trailing.op === 'replace_declaration' ? trailing.declaration : '', /run: Map<string, \{\s*id: string;\s*msg: string;?\s*\}> = 1;/u);
  assert.throws(() => compile({ op: 'replace_declaration_ir', file: 'a.ts', symbol: 'run', ...target(source),
    declaration: { kind: 'return', argument: literal(1) } }), /declaration positions accept only/);
  assert.throws(() => TypedPatchOp.parse({ op: 'create_file_ir', file: 'a.ts', module: { version: 1, body: [
    { kind: 'expression_statement', expression: { kind: 'rawCode', text: 'process.exit()' } },
  ] } }));
});

test('v5 rejects raw code operations but keeps docs and mechanical operations compatible', () => {
  assert.throws(() => parseGuidedReply(JSON.stringify({ action: 'patch', prediction: 'raw', ops: [
    { op: 'replace_body', file: 'src/a.ts', symbol: 'run', body: 'return 1;' },
  ] }), true), /Raw replace_body/);
  assert.throws(() => parseGuidedReply(JSON.stringify({ action: 'patch', prediction: 'typed', ops: [
    { op: 'create_file_ir', file: 'a.ts', module: { version: 1, body: [{ kind: 'variable_declaration', declarationKind: 'const', name: 'x', initializer: literal(1) }] } },
  ] }), false), /только в guided v5/);
  assert.throws(() => parseGuidedReply(JSON.stringify({ action: 'patch', prediction: 'unsupported', ops: [
    { op: 'replace_body', file: 'src/a.py', symbol: 'run', body: 'return 1' },
  ] }), true), (error: unknown) => error instanceof DecisionError && error.category === 'unsupported');
  const mechanical = parseGuidedReply(JSON.stringify({ action: 'patch', prediction: 'mechanical', ops: [
    { op: 'ensure_import', file: 'src/a.ts', from: './b.ts', names: ['b'] },
  ] }), true);
  assert.equal(mechanical.action === 'patch' && mechanical.ops[0]?.op, 'ensure_import');
  const doc = parseGuidedReply(JSON.stringify({ action: 'patch', prediction: 'doc', ops: [
    { op: 'replace_text', file: 'README.md', expectedHash: 'a'.repeat(64), search: 'old', replacement: 'new' },
  ] }), true);
  assert.equal(doc.action === 'patch' && doc.ops[0]?.op, 'replace_text');
});

test('v5 compiles split IR parts of one new module as one ordered create operation', () => {
  const declaration = (name: string, value: number) => ({ kind: 'variable_declaration', declarationKind: 'const', name, initializer: literal(value), export: true });
  const result = parseGuidedReply(JSON.stringify({ action: 'patch', prediction: 'parts', ops: [
    { op: 'create_file_ir', file: 'src/a.ts', module: { version: 1, body: [declaration('first', 1)] } },
    { op: 'create_file_ir', file: 'src/a.ts', module: { version: 1, body: [declaration('second', 2)] } },
  ] }), true);
  assert.equal(result.action, 'patch');
  if (result.action !== 'patch') return;
  assert.equal(result.ops.length, 1);
  assert.equal(result.ops[0]?.op, 'create_file');
  const body = result.ops[0] && 'body' in result.ops[0] ? result.ops[0].body : '';
  assert.ok(body.indexOf('first') < body.indexOf('second'));
  assert.match(body, /export const first = 1/);
  assert.match(body, /export const second = 2/);
});

test('compiled typed operation uses existing freshness and target simulation', t => {
  const root = mkdtempSync(join(tmpdir(), 'typed-ir-stale-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = 'export function run() { return 1; }\n';
  writeFileSync(join(root, 'a.ts'), source);
  const operation = compile({ op: 'replace_function_ir', file: 'a.ts', symbol: 'run', ...target(source), body: [{ kind: 'return', argument: literal(2) }] });
  assert.deepEqual(simulateOps(root, ['a.ts'], [operation])[0]?.after, 'export function run() {\nreturn 2;\n}\n');
  writeFileSync(join(root, 'a.ts'), 'export function run() { return 3; }\n');
  assert.throws(() => simulateOps(root, ['a.ts'], [operation]), (error: unknown) => error instanceof GuidedOpError && /изменился/.test(error.message));
  assert.equal(readFileSync(join(root, 'a.ts'), 'utf8'), 'export function run() { return 3; }\n');
});

test('typed schema offers no raw code payloads and bound schema keeps runtime identities', () => {
  const card = { path: 'a.ts', hash: 'a'.repeat(64), symbols: ['run'], isNew: false,
    targets: [{ symbol: 'run', targetId: 'b'.repeat(64), executable: true }] };
  const typed = guidedActionResponseFormat([card], false, undefined, undefined, undefined, true) as any;
  const patch = typed.json_schema.schema.oneOf.find((value: any) => value.properties.action.const === 'patch');
  const variants = patch.properties.ops.items.oneOf;
  assert.ok(variants.some((value: any) => value.properties.op.const === 'replace_declaration_ir'));
  assert.ok(variants.some((value: any) => value.properties.op.const === 'replace_function_ir'));
  assert.ok(!variants.some((value: any) => ['replace_body', 'replace_declaration', 'replace_function_body', 'insert_after', 'insert_before'].includes(value.properties.op.const)));
  assert.ok(variants.filter((value: any) => value.properties.op.const.endsWith('_ir')).every((value: any) => value.additionalProperties === false));
  const validator = z.fromJSONSchema(typed.json_schema.schema);
  assert.doesNotThrow(() => validator.parse({ action: 'patch', prediction: 'recursive statement', ops: [{
    op: 'replace_declaration_ir', file: 'a.ts', symbol: 'run', expectedHash: 'a'.repeat(64), targetId: 'b'.repeat(64),
    declaration: { kind: 'function_declaration', name: 'run', params: [], body: { kind: 'block', body: [{ kind: 'return', argument: literal(1) }] } },
  }] }));
  const repaired = guidedActionResponseFormat([card], false, { file: 'a.ts', ops: ['replace_function_body'] }, undefined, undefined, true) as any;
  const repairedPatch = repaired.json_schema.schema.oneOf.find((value: any) => value.properties.action.const === 'patch');
  assert.deepEqual(repairedPatch.properties.ops.items.properties.op.const, 'replace_function_ir');
  const bound = guidedBoundActionResponseFormat([card], false, undefined, undefined, 'run', undefined, true) as any;
  const boundPatch = bound.json_schema.schema.oneOf.find((value: any) => value.properties.action.const === 'patch');
  const boundVariants = boundPatch.properties.ops.items.oneOf;
  assert.ok(boundVariants.every((value: any) => !('file' in value.properties) && !('symbol' in value.properties)));
  const raw = guidedActionResponseFormat([card]) as any;
  assert.match(JSON.stringify(raw), /replace_body/);
});

test('bound typed reply receives file and symbol before deterministic compilation', () => {
  const source = 'export const run = 1;\n';
  const parsed = parseBoundGuidedReply(JSON.stringify({ action: 'patch', prediction: 'typed', ops: [{
    op: 'replace_declaration_ir', ...target(source), declaration: { kind: 'variable_declaration', declarationKind: 'const', name: 'run', initializer: literal(2), export: true },
  }] }), 'a.ts', 'run', true);
  assert.deepEqual(parsed.action === 'patch' ? parsed.ops[0] : null, {
    op: 'replace_declaration', file: 'a.ts', symbol: 'run', ...target(source), declaration: 'export const run = 2;',
  });
});

test('typed compile errors enter DecisionEngine recovery and validation returns the original candidate', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'typed-ir-decision-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const source = 'export const run = 1;\n';
  const candidate = (typeText: string) => ({ action: 'patch', prediction: 'typed', ops: [{
    op: 'replace_declaration_ir', file: 'a.ts', symbol: 'run', ...target(source),
    declaration: { kind: 'variable_declaration', declarationKind: 'const', name: 'run', type: { kind: 'type', text: typeText }, initializer: literal(2), export: true },
  }] });
  const valid = candidate('number');
  assert.strictEqual(validateGuidedReplyCandidate(valid, true), valid);
  const packets: any[] = [];
  const provider: ChatProvider = { name: 'test', async chat(request) {
    packets.push(JSON.parse(request.messages[1]!.content));
    return { text: JSON.stringify(packets.length === 1 ? candidate('number; invalid') : valid), toolCalls: [], finishReason: 'end_turn', usage: emptyUsage() };
  } };
  const context = { revision: 'r1', task: ['typed'], constraints: { writable: ['a.ts'] }, sourceVersions: { 'a.ts': hash(source) } };
  const engine = new DecisionEngine({ provider, directory, capture: () => context, contextWindow: 10000 });
  const result = await engine.decide({ questionId: 'typed-chunk', question: {}, context, instructions: 'Return typed IR',
    schema: { type: 'object' }, params: {}, model: 'test', signal: new AbortController().signal,
    validate: value => validateGuidedReplyCandidate(value, true) });
  assert.equal(result.attempts, 2);
  assert.match(packets[1].recovery.diagnostics, /Invalid TYPE node/);
  assert.deepEqual(result.value, valid);
  await assert.rejects(new DecisionEngine({ provider, directory, capture: () => context, contextWindow: 10000 }).decide({
    questionId: 'typed-chunk-invalid', question: {}, context, instructions: 'Return typed IR', schema: { type: 'object' }, params: {}, model: 'test',
    signal: new AbortController().signal, requestLimit: 1, validate: () => { throw new DecisionError('invalid-response', 'invalid', 'test'); },
  }), DecisionError);
});

// Сквозной контракт «адаптер × validate-хук»: что вернул адаптер, исполнитель обязан
// разобрать тем же парсером, что и живой ответ. r6 (2026-10-27): хук отдавал
// скомпилированный create_file, и верный create_file_ir четырежды шёл классом «format».
test('decisionProvider output re-parses with the executor parsers for bound and unbound typed replies', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'typed-ir-roundtrip-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const module = { version: 1, body: [{ kind: 'function_declaration', name: 'validateCustomer', export: true, async: false,
    params: [{ name: 'customer', type: { kind: 'type', text: 'Customer' } }], returnType: { kind: 'type', text: 'string[]' },
    body: { kind: 'block', body: [{ kind: 'return', argument: { kind: 'array', elements: [] } }] } }] };
  const bound = { action: 'patch', prediction: 'создан модуль', ops: [{ op: 'create_file_ir', module }] };
  const unbound = { action: 'patch', prediction: 'создан модуль', ops: [{ op: 'create_file_ir', file: 'src/validate.ts', module }] };
  const context = { revision: 'r1', task: ['typed'], constraints: { writable: ['src/validate.ts'] }, sourceVersions: {} };
  const cases: { candidate: unknown; validate: (value: unknown) => unknown; reparse: (text: string) => unknown }[] = [
    { candidate: bound, validate: value => validateBoundGuidedReplyCandidate(value, 'src/validate.ts', undefined, true),
      reparse: text => parseBoundGuidedReply(text, 'src/validate.ts', undefined, true) },
    { candidate: unbound, validate: value => validateGuidedReplyCandidate(value, true), reparse: text => parseGuidedReply(text, true) },
  ];
  for (const { candidate, validate, reparse } of cases) {
    const provider: ChatProvider = { name: 'test', async chat() { return { text: JSON.stringify(candidate), toolCalls: [], finishReason: 'end_turn', usage: emptyUsage() }; } };
    const adapter = decisionProvider(provider, { directory, capture: () => context, contextWindow: 20000 });
    const turn = await adapter.chat({ model: 'test', messages: [{ role: 'system', content: 'typed' }, { role: 'user', content: JSON.stringify({ questionId: 'chunk' }) }],
      tools: [], temperature: null, signal: new AbortController().signal, validate,
      params: { max_tokens: 2000, response_format: { type: 'json_schema', json_schema: { name: 'guided_action', schema: { type: 'object' } } } } });
    assert.deepEqual(JSON.parse(turn.text), candidate);
    const reply = reparse(turn.text) as { action: string; ops: { op: string; file: string }[] };
    assert.equal(reply.action, 'patch');
    assert.deepEqual(reply.ops.map(op => [op.op, op.file]), [['create_file', 'src/validate.ts']]);
  }
});

test('schema diagnostics name the field path and stay short instead of echoing the union dump', () => {
  const result = z.object({ action: z.literal('patch'), ops: z.array(z.discriminatedUnion('op', [
    z.object({ op: z.literal('create_file'), file: z.string() }).strict(),
    z.object({ op: z.literal('delete'), file: z.string(), symbol: z.string() }).strict(),
  ])) }).strict().safeParse({ action: 'patch', ops: [{ op: 'create_file_ir', module: {} }] });
  assert.ok(!result.success);
  const summary = summarizeReplyError(result.error);
  assert.match(summary, /^ops\.0\.op: /u);
  assert.ok(summary.length <= 600);
  assert.ok(!summary.includes('\n'));
  assert.equal(summarizeReplyError(new Error('Файл операции уже закреплён рантаймом')), 'Файл операции уже закреплён рантаймом');
  assert.ok(summarizeReplyError(new Error('x'.repeat(2000)), 100).length === 100);
});
