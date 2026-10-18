/**
 * Имя инструмента в канонической форме: регистр и `_`/`-` вызов не решают.
 *
 * Мишень — измеренный класс, а не удобство: модели школы harmony (gpt-oss) пишут имена
 * строчными и в стиле `apply_patch`, и за ОДНУ попытку это дало пять отказов «инструмент
 * не объявлен» на вызовах `grep`/`read`/`glob` с верными аргументами (bench,
 * vat-rounding, 2026-09-24). Отдельно от `conformance.test.ts`: там сверяются две формы
 * ОДНОГО имени у двух флоу, здесь — разные написания одного и того же инструмента.
 */

import { deepStrictEqual, strictEqual } from 'node:assert/strict';
import { describe, it } from 'node:test';

import { normalize } from '../src/exec/normalize.ts';

describe('normalize: написание имени инструмента', () => {
  it('строчные имена harmony-стиля разбираются как канонические', () => {
    deepStrictEqual(normalize('read', { file_path: 'src/a.ts' }), {
      kind: 'read',
      path: 'src/a.ts',
      range: null,
    });
    strictEqual(normalize('grep', { pattern: 'Object.keys', path: 'src' }).kind, 'grep');
    strictEqual(normalize('glob', { pattern: '*.ts' }).kind, 'glob');
    strictEqual(normalize('write', { file_path: 'src/a.ts', content: 'x' }).kind, 'write');
    strictEqual(normalize('bash', { command: 'node --test' }).kind, 'bash');
  });

  it('регистр и разделители не различают: GREP, MultiEdit, multi_edit — один вид', () => {
    strictEqual(normalize('GREP', { pattern: 'x' }).kind, 'grep');
    const edits = { edits: [{ old_string: 'a', new_string: 'b' }] };
    strictEqual(normalize('MultiEdit', { file_path: 'src/a.ts', ...edits }).kind, 'edit');
    strictEqual(normalize('multi_edit', { file_path: 'src/a.ts', ...edits }).kind, 'edit');
    strictEqual(normalize('multiedit', { file_path: 'src/a.ts', ...edits }).kind, 'edit');
  });

  it('инструменты рантайма тоже: askhuman, finalizeartifact, fillfield, recordclaim', () => {
    strictEqual(normalize('askhuman', { questions: [] }).kind, 'ask_human');
    strictEqual(normalize('finalizeartifact', { artifact: '.sdlc/x/plan.md' }).kind, 'finalize_artifact');
    strictEqual(normalize('fillfield', { artifact: 'plan', field: 'подход', value: 'x' }).kind, 'fill_field');
    strictEqual(
      normalize('recordclaim', { id: 'claim-1', status: '✅', evidence: 'src/a.ts:10' }).kind,
      'record_claim',
    );
  });

  // Имя, приведённое к канону, не должно проглотить чужой MCP-инструмент: префикс `mcp__`
  // в каноне остаётся, в карту не попадает, и вызов уходит своим путём — `mcp`, а у
  // несуществующего сервера `sdlc` по-прежнему `unknown` (худший случай).
  it('внешний MCP-инструмент каноном не задет', () => {
    const call = normalize('mcp__unreal__read', { path: '/Game/Cards/BP_Card' });
    strictEqual(call.kind, 'mcp');
    strictEqual(normalize('mcp__sdlc__чего_нет', {}).kind, 'unknown');
  });

  it('незнакомое имя по-прежнему unknown, а не угадывается', () => {
    strictEqual(normalize('patch', { patch: '*** Begin Patch' }).kind, 'unknown');
    strictEqual(normalize('toString', {}).kind, 'unknown');
    strictEqual(normalize('constructor', {}).kind, 'unknown');
  });

  it('верное имя с битыми аргументами остаётся unknown (аргументы важнее регистра)', () => {
    // `Edit` без `old_string` — живой класс gpt-oss: новый файл одним `new_string`.
    strictEqual(normalize('edit', { file_path: 'test/a.test.ts', new_string: 'x' }).kind, 'unknown');
  });
});
