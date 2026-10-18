import test from 'node:test';
import assert from 'node:assert/strict';
import { parseGuidedTurn } from '../src/exec/GuidedExecutor.ts';

test('parseGuidedTurn falls back to no_change for invalid JSON', () => {
  const result = parseGuidedTurn({ text: 'not json at all', toolCalls: [] });
  assert.equal(result.action, 'no_change');
  assert.match(result.reason!, /Невалидный JSON/);
});

test('parseGuidedTurn extracts a JSON object embedded in prose', () => {
  const text = 'Here is the proposed action:\n```json\n{"action":"read","path":"src/a.ts","offset":1,"limit":80}\n```\nMore text.';
  const result = parseGuidedTurn({ text, toolCalls: [] });
  assert.equal(result.action, 'read');
  assert.equal((result as any).path, 'src/a.ts');
});

test('parseGuidedTurn still parses a clean JSON reply', () => {
  const text = JSON.stringify({ action: 'search', pattern: 'validate' });
  const result = parseGuidedTurn({ text, toolCalls: [] });
  assert.equal(result.action, 'search');
  assert.equal((result as any).pattern, 'validate');
});

test('parseGuidedTurn falls back when JSON is truncated', () => {
  const text = '{"action":"patch","prediction":"fix","ops":[';
  const result = parseGuidedTurn({ text, toolCalls: [] });
  assert.equal(result.action, 'no_change');
});

test('parseGuidedTurn still rejects unsafe tool calls that do not match the guided schema', () => {
  const call = { id: '1', name: 'Bash', arguments: { command: 'echo unsafe' }, rawArguments: '' };
  assert.throws(() => parseGuidedTurn({ text: '', toolCalls: [call] }));
});
