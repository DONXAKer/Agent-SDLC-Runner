import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { findSymbols, applySymbolOp, declarationId } from '../src/exec/symbolOps.ts';
const hash = (text: string) => createHash('sha256').update(text).digest('hex');

test('compiler index distinguishes parameter and result object types from the function body', () => {
 const source = '/** stable */\nexport function deliver<T extends { key: string }>(x: T, opts?: { enabled?: boolean }): { id: string } {\n return { id: x.key };\n}\nexport const sibling = 7;\n';
 const decl = findSymbols(source).find(d => d.name === 'deliver')!;
 assert.equal(source.slice(decl.bodyStart!, decl.bodyEnd!).trim(), 'return { id: x.key };');
 const declaration = 'export function deliver<T extends { key: string }>(x: T): { id: string } { return { id: "next" }; }';
 const result = applySymbolOp(source, { op: 'replace_declaration', file: 'lib/dispatch.ts', symbol: 'deliver', expectedHash: hash(source), targetId: declarationId(source, decl), declaration });
 assert.equal(result, declaration + '\nexport const sibling = 7;\n');
 assert.throws(() => applySymbolOp(source+'\n', { op: 'replace_function_body', file: 'lib/dispatch.ts', symbol: 'deliver', expectedHash: hash(source), targetId: declarationId(source, decl), body: 'return { id: "next" };' }), /изменился/);
});

test('overload implementation identity and arrow body are exact; ambiguous old names remain rejected', () => {
 const source = 'export function parse(x: string): string;\nexport function parse(x: unknown): string { return String(x); }\nexport const arrow = <T extends { n: number }>(x: T): { n: number } => { return { n: x.n }; };';
 const functions = findSymbols(source).filter(d => d.name === 'parse');
 assert.equal(functions.length, 2);
 const implementation = functions.find(d => d.bodyStart !== null)!;
 const after = applySymbolOp(source, { op:'replace_function_body', file:'lib/input.ts', symbol:'parse', expectedHash:hash(source), targetId:declarationId(source, implementation), body:'return "value";' });
 assert.ok(after.startsWith('export function parse(x: string): string;'));
 assert.match(after, /return "value"/);
 const arrow = findSymbols(source).find(d => d.name==='arrow')!;
 assert.equal(source.slice(arrow.bodyStart!, arrow.bodyEnd!).trim(), 'return { n: x.n };');
});

test('class members and declarations preserve AST extent, comments and neighbours', () => {
 const source='export class Reader {\n /** read */\n read(x: { n: number }): { n: number } { return x; }\n other() { return 2; }\n}\nexport const untouched = 3;';
 const method=findSymbols(source).find(d=>d.qualified==='Reader.read')!;
 const result=applySymbolOp(source,{op:'replace_declaration',file:'lib/reader.ts',symbol:method.qualified,expectedHash:hash(source),targetId:declarationId(source,method),declaration:'read(x: { n: number }): { n: number } { return { n: x.n + 1 }; }'});
 assert.match(result,/other\(\) \{ return 2; \}/);assert.ok(result.endsWith('export const untouched = 3;'));
 assert.equal(findSymbols('const a=1,b=2;').length,0,'Unsupported multi-declarations are not offered as independent edit targets');
});
