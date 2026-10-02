import { ok, strictEqual } from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, it } from 'node:test';

import { buildRuntimeLocatorMap, fillVerifiedChunkLocation, validateLocatorMap } from '../src/run/chunkLocatorApproval.ts';

const roots: string[] = [];
after(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });
function root(): string {
  const path = realpathSync(mkdtempSync(join(tmpdir(), 'sdlc-locator-map-')));
  roots.push(path);
  mkdirSync(join(path, 'src'), { recursive: true });
  writeFileSync(join(path, 'src', 'hold.ts'), 'export interface Hold { id: string }\n');
  return path;
}

it('accepts only complete, plan-bound maps with a verbatim source anchor', () => {
  const project = root();
  const result = validateLocatorMap(JSON.stringify({
    status: 'matched',
    reason: null,
    files: [
      { path: 'src/hold.ts', state: 'existing', anchor: 'export interface Hold', change: 'add moveHold after the type' },
      { path: 'test/new.test.ts', state: 'new', anchor: null, change: 'create moveHold tests' },
    ],
  }), ['src/hold.ts', 'test/new.test.ts'], project);
  ok(result.ok);
  if (result.ok) strictEqual(result.value.files.length, 2);
});

it('extracts one strict JSON map from explanatory prose without trusting the prose', () => {
  const project = root();
  const response = [
    'Карта совпала; найденные якоря перечислены ниже.',
    '```json',
    JSON.stringify({
      status: 'matched', reason: null,
      files: [{ path: 'src/hold.ts', state: 'existing', anchor: 'export interface Hold', change: 'add moveHold' }],
    }),
    '```',
  ].join('\n');
  ok(validateLocatorMap(response, ['src/hold.ts'], project).ok);
  strictEqual(validateLocatorMap(`${response}\n\n\`\`\`json\n{}\n\`\`\``, ['src/hold.ts'], project).ok, false);
});

it('rejects missing, extra, mismatched and ungrounded paths', () => {
  const project = root();
  const base = { status: 'matched', reason: null, files: [{ path: 'src/hold.ts', state: 'existing', anchor: 'export interface Hold', change: 'add function' }] };
  const missing = validateLocatorMap(JSON.stringify(base), ['src/hold.ts', 'src/index.ts'], project);
  strictEqual(missing.ok, false);
  const extra = validateLocatorMap(JSON.stringify({ ...base, files: [...base.files, { path: 'src/other.ts', state: 'new', anchor: null, change: 'extra' }] }), ['src/hold.ts'], project);
  strictEqual(extra.ok, false);
  const ungrounded = validateLocatorMap(JSON.stringify({ ...base, files: [{ ...base.files[0], anchor: 'fake symbol' }] }), ['src/hold.ts'], project);
  strictEqual(ungrounded.ok, false);
  const diverged = validateLocatorMap(JSON.stringify({ ...base, status: 'diverged' }), ['src/hold.ts'], project);
  strictEqual(diverged.ok, false);
});

it('builds a complete fallback map from approved plan paths with exact filesystem anchors', () => {
  const project = root();
  mkdirSync(join(project, 'test'), { recursive: true });
  const plan = [
    '### Шаг 1 — Реализовать moveHold',
    '- файл: src/hold.ts (существующий)',
    '- символ: moveHold',
    '- действие: добавить moveHold',
    '',
    '### Шаг 2 — Проверить moveHold',
    '- файл: test/new.test.ts (новый)',
    '- символ: тест moveHold',
    '- действие: добавить тесты',
    '',
    '## files_to_touch',
    '| Путь | Что делаем |',
    '|---|---|',
    '| src/hold.ts | добавить moveHold |',
    '| test/new.test.ts | создать тесты |',
  ].join('\n');
  const result = buildRuntimeLocatorMap(plan, project);
  ok(result !== null);
  strictEqual(result?.files.length, 2);
  strictEqual(result?.files[0]?.anchor, 'export interface Hold { id: string }');
  strictEqual(result?.files[1]?.state, 'new');
  strictEqual(result?.files[1]?.anchor, null);
});

it('reuses plan approval only when all journal decision placeholders are present', () => {
  const journal = [
    '- Точки правки по итогам точечной разведки: ‹файл:символ, …›',
    '- Карта разведки: совпала / разошлась — ‹что именно; расхождение = возврат на план›',
    '- **Подтвердил:** ‹имя› · ‹дата›',
  ].join('\n');
  const files = [{ path: 'src/hold.ts', state: 'existing' as const, anchor: 'export interface Hold', change: 'add moveHold' }];
  const filled = fillVerifiedChunkLocation(journal, files, '2026-10-02', ['src/hold.ts:moveHold']);
  ok(filled?.includes('src/hold.ts:moveHold'));
  ok(filled?.includes('Карта разведки: совпала — src/hold.ts: якорь найден в файле'));
  ok(filled?.includes('одобрение плана этой сессии · 2026-10-02'));
  strictEqual(filled?.includes('‹дата›'), false);
  strictEqual(fillVerifiedChunkLocation(journal, files, '2026-10-02', []), null);
});
