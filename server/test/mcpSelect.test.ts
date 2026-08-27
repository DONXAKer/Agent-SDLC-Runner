/**
 * Отбор набора MCP-инструментов.
 *
 * Это не оптимизация: один generic-сервер Unreal отдаёт 175 инструментов, их описания со
 * схемами — порядка сорока тысяч токенов, то есть вдвое-втрое больше ВСЕГО контекста
 * локальной модели. Поэтому проверяется не только «выбрано верное», но и «отброшенное
 * названо»: молча укороченный набор читается как «дали всё, что просили».
 */

import { ok, strictEqual } from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { McpToolRule } from '@sdlc-runner/shared';

import { estimateTokens, selectTools } from '../src/mcp/select.ts';
import type { McpToolInfo } from '../src/mcp/types.ts';
import { fullName } from '../src/mcp/naming.ts';

const info = (tool: string, server = 'unreal'): McpToolInfo => ({
  server,
  tool,
  name: fullName(server, tool),
  description: 'описание',
  schema: { type: 'object', properties: {} },
  readOnlyHint: null,
  destructiveHint: null,
});

const rule = (tool: string, server = 'unreal'): McpToolRule => ({
  server,
  tool,
  mode: 'write',
  pathArgs: [],
});

describe('отбор набора MCP-инструментов', () => {
  it('шаблон раскрывается по фактическому списку сервера', () => {
    const sel = selectTools(
      [rule('pie_*')],
      [info('pie_start'), info('pie_stop'), info('spawn_actor')],
      12,
    );
    strictEqual(sel.tools.map((t) => t.tool).join(','), 'pie_start,pie_stop');
  });

  it('инструмент чужого сервера под правило не подпадает', () => {
    const sel = selectTools([rule('pie_start')], [info('pie_start', 'другой')], 12);
    strictEqual(sel.tools.length, 0);
  });

  it('правило без инструмента на сервере попадает в отброшенные, а не в тишину', () => {
    // «Инструмента нет» и «инструмент запрещён» выглядят для модели одинаково, а чинятся
    // по-разному: первое — поднять редактор, второе — поправить конфиг.
    const sel = selectTools([rule('pie_start')], [], 12);
    strictEqual(sel.tools.length, 0);
    ok(sel.dropped.some((d) => d.name.includes('pie_start')));
  });

  it('набор режется потолком, и обрезка названа', () => {
    const tools = ['a', 'b', 'c', 'd'].map((t) => info(t));
    const sel = selectTools([rule('a'), rule('b'), rule('c'), rule('d')], tools, 2);
    strictEqual(sel.tools.length, 2);
    strictEqual(sel.dropped.length, 2);
    ok(sel.dropped.every((d) => d.why.includes('потолку')));
  });

  it('слишком длинное имя выкидывается: часть провайдеров отвергает такое поле', () => {
    const long = 'x'.repeat(80);
    const sel = selectTools([rule(long)], [info(long)], 12);
    strictEqual(sel.tools.length, 0);
    ok(sel.dropped.some((d) => d.why.includes('длиннее')));
  });

  it('цена набора считается, чтобы её было видно до запуска этапа', () => {
    strictEqual(estimateTokens([]), 0);
    ok(estimateTokens([info('pie_start')]) > 0);
  });
});
