import { test } from 'node:test';
import { doesNotThrow, strictEqual } from 'node:assert/strict';
import { z } from 'zod';
import { guidedActionResponseFormat, guidedBoundActionResponseFormat, validateBoundGuidedReplyCandidate } from '../src/exec/GuidedExecutor.ts';

test('composed and bound typed schemas resolve recursive references before the model call', () => {
  const hash = 'a'.repeat(64), targetId = 'b'.repeat(64);
  const file = { path: 'lib/read.ts', hash, symbols: ['read'], isNew: false, targets: [{ symbol: 'read', targetId, executable: true }] };
  const declaration = { kind: 'function_declaration', name: 'read', params: [], body: { kind: 'block', body: [{ kind: 'return', argument: { kind: 'literal', value: 1 } }] }, export: true };
  const op = { op: 'replace_declaration_ir', expectedHash: hash, targetId, declaration };
  const response = { action: 'patch', prediction: 'read returns one', ops: [op] };
  const full = guidedActionResponseFormat([file], false, undefined, undefined, undefined, true) as { json_schema: { schema: Record<string, unknown> } };
  doesNotThrow(() => z.fromJSONSchema(full.json_schema.schema).parse({ ...response, ops: [{ ...op, file: file.path, symbol: 'read' }] }));
  const bound = guidedBoundActionResponseFormat([file], false, undefined, undefined, 'read', undefined, true) as { json_schema: { schema: Record<string, unknown> } };
  doesNotThrow(() => z.fromJSONSchema(bound.json_schema.schema).parse(response));
  strictEqual(validateBoundGuidedReplyCandidate(response, file.path, 'read', true), response);
  const fresh = guidedBoundActionResponseFormat([{ path: 'lib/new.ts', hash, symbols: [], isNew: true }], false, undefined, undefined, undefined, undefined, true) as { json_schema: { schema: Record<string, unknown> } };
  doesNotThrow(() => z.fromJSONSchema(fresh.json_schema.schema).parse({ action: 'patch', prediction: 'new module', ops: [{ op: 'create_file_ir', module: { version: 1, body: [declaration] } }] }));
});
