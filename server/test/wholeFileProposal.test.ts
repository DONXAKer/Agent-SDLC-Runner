import { test } from 'node:test';
import assert from 'node:assert/strict';
import { digest } from '../src/run/guidedState.ts';
import { compileWholeFileOperation, prepareWholeFileGroup, prepareWholeFileProposal } from '../src/exec/wholeFileProposal.ts';

const reply = { content: 'export const value = 2;\r\n', prediction: 'Update value', evidenceIds: ['source-1'] };
test('whole-file preserves exact bytes and supports creation', () => {
  const result = prepareWholeFileProposal({ path: 'src/value.ts', before: null, expectedHash: 'missing' }, reply, null);
  assert.deepEqual(result.snapshot, { path: 'src/value.ts', before: null, after: reply.content });
});
test('whole-file replacement rejects stale and inconsistent captures', () => {
  const target = { path: 'src/value.ts', before: 'old', expectedHash: digest('old') };
  assert.equal(prepareWholeFileProposal(target, reply, 'old').snapshot.before, 'old');
  assert.throws(() => prepareWholeFileProposal(target, reply, 'changed'), /changed/);
  assert.throws(() => prepareWholeFileProposal({ ...target, before: 'wrong' }, reply, 'old'), /changed/);
  assert.throws(() => prepareWholeFileProposal(target, reply, null), /changed/);
});
test('whole-file rejects truncation, binary content and model-selected paths', () => {
  const target = { path: 'src/value.ts', before: null, expectedHash: 'missing' };
  for (const reason of ['max_tokens', 'length'])
    assert.throws(() => prepareWholeFileProposal(target, reply, null, reason), /truncated/);
  assert.throws(() => prepareWholeFileProposal(target, { ...reply, content: '\0' }, null), /Binary/);
  assert.throws(() => prepareWholeFileProposal(target, { ...reply, path: '../escape' }, null));
  assert.throws(() => prepareWholeFileProposal(target, { ...reply, evidenceIds: [] }, null));
});
test('group preparation rejects unauthorized, duplicate and stale members', () => {
  const first = { target: { path: 'a.ts', before: null, expectedHash: 'missing' }, candidate: reply, current: null };
  const second = { target: { path: 'b.ts', before: 'old', expectedHash: digest('old') }, candidate: reply, current: 'old' };
  assert.equal(prepareWholeFileGroup([first, second], ['a.ts', 'b.ts']).length, 2);
  assert.throws(() => prepareWholeFileGroup([first, second], ['a.ts']), /outside/);
  assert.throws(() => prepareWholeFileGroup([first, first], ['a.ts']), /Duplicate/);
  assert.throws(() => prepareWholeFileGroup([first, { ...second, current: 'changed' }], ['a.ts', 'b.ts']), /changed/);
});
test('rejects invalid TypeScript and unsupported file types before preparing a snapshot', () => {
  const target = { path: 'src/value.ts', before: null, expectedHash: 'missing' };
  assert.throws(() => prepareWholeFileProposal(target, { ...reply, content: 'const x = ;' }, null), /syntax invalid/);
  assert.throws(() => prepareWholeFileProposal({ ...target, path: 'src/value.tsx' }, reply, null), /unsupported/);
});
test('compiles only an authorized exact symbol change', () => {
  const before = 'export const value = 1;\nexport const other = 3;\n';
  const after = 'export const value = 2;\nexport const other = 3;\n';
  const snapshot = { path: 'src/value.ts', before, after };
  assert.equal(compileWholeFileOperation(snapshot, ['replace_declaration'], 'value').op, 'replace_declaration');
  assert.throws(() => compileWholeFileOperation(snapshot, ['replace_declaration'], 'other'), /authorized/);
  assert.throws(() => compileWholeFileOperation({ ...snapshot, after: after.replace('other = 3', 'other = 4') }, ['replace_declaration']), /authorized/);
});
test('compiles create_file even when EOL canonicalization would change proposed bytes', () => {
  // Пилот r10 клетки 2–3: модель отдавала CRLF / без финального \\n — applySymbolOp
  // канонизирует, старая сверка apply===after роняла создание.
  const crlf = { path: 'src/new.ts', before: null, after: 'export const value = 1;\r\n' };
  const bare = { path: 'src/new.ts', before: null, after: 'export const value = 1;' };
  assert.equal(compileWholeFileOperation(crlf, ['create_file']).op, 'create_file');
  assert.equal(compileWholeFileOperation(bare, ['create_file']).op, 'create_file');
  assert.throws(() => compileWholeFileOperation(crlf, ['replace_declaration']), /creation is not authorized/i);
});
