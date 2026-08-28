/**
 * Права и одобрение для вызовов внешних MCP-серверов.
 *
 * Проверяется ровно то, на чём держится обещание «разрешительный список + одобрение на
 * изменяющие»: имя инструмента решает, а не вид вызова; класс задаёт человек; читающий
 * идёт без паузы, изменяющий — только через оператора или свой флаг; аргумент-путь
 * проверяется, только если человек назвал его путём.
 */

import { ok, strictEqual } from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { McpToolRule, NormalizedCall, PolicyContext, ToolName } from '@sdlc-runner/shared';

import { ApprovalGate } from '../src/approval/gate.ts';
import { normalize } from '../src/exec/normalize.ts';
import { evaluate, writeTargetPaths } from '../src/policy/index.ts';
import { effectiveMode } from '../src/policy/mcp.ts';

const ROOT = 'D:/proj';

const ctx = (over: Partial<PolicyContext> = {}): PolicyContext => ({
  projectRoot: ROOT,
  stage: 'chunk',
  sdlcDir: '.sdlc/x',
  planFiles: ['src/a.ts'],
  protectedArtifacts: [],
  readOnlyRoots: [],
  allowedTools: ['Read', 'Write', 'McpRead', 'McpWrite'] satisfies ToolName[],
  mcpTools: [],
  ...over,
});

const rule = (over: Partial<McpToolRule> = {}): McpToolRule => ({
  server: 'unreal',
  tool: 'pie_status',
  mode: 'read',
  pathArgs: [],
  ...over,
});

const call = (tool: string, args: Record<string, unknown> = {}): NormalizedCall => ({
  kind: 'mcp',
  server: 'unreal',
  tool,
  args,
});

describe('политика: инструменты внешних MCP-серверов', () => {
  it('инструмента нет в списке — отказ, и причина называет сервер и что разрешено', () => {
    const v = evaluate(call('delete_asset'), ctx({ mcpTools: [rule()] }));
    ok(!v.ok);
    strictEqual(v.policy, 'stageTools');
    ok(v.reason.includes('delete_asset'));
    ok(v.reason.includes('unreal'));
    // Подсказка перечисляет разрешённое: отказ без неё заставляет модель угадывать.
    ok(v.reason.includes('pie_status'));
  });

  it('точное имя бьёт шаблон, и более строгий класс побеждает при равенстве', () => {
    // Шаблон разрешает семейство на запись, точное имя выделяет из него читающий.
    const rules = [rule({ tool: 'pie_*', mode: 'write' }), rule({ tool: 'pie_status', mode: 'read' })];
    const c = ctx({ mcpTools: rules, allowedTools: ['McpRead'] });
    strictEqual(evaluate(call('pie_status'), c).ok, true);
    // А `pie_start` остаётся изменяющим — и без права `McpWrite` не проходит.
    ok(!evaluate(call('pie_start'), c).ok);
  });

  it('суженный субагент без McpWrite не получает изменяющий вызов', () => {
    const c = ctx({
      mcpTools: [rule({ tool: 'spawn_actor', mode: 'write' })],
      // Так выглядит пересечение прав read-only субагента с правами этапа.
      allowedTools: ['Read', 'McpRead'],
    });
    const v = evaluate(call('spawn_actor'), c);
    ok(!v.ok);
    strictEqual(v.policy, 'stageTools');
  });

  it('путь ассета Unreal не считается путём файловой системы', () => {
    // `/Game/Cards/BP_Card` проходит `isAbsolute` и лежит «вне проекта» — без явного
    // объявления аргумента путём это давало бы отказ на КАЖДОМ вызове с ассетом.
    const c = ctx({ mcpTools: [rule({ tool: 'asset_exists', mode: 'read' })] });
    strictEqual(evaluate(call('asset_exists', { path: '/Game/Cards/BP_Card' }), c).ok, true);
  });

  it('объявленный аргумент-путь проверяется как обычная запись', () => {
    const c = ctx({
      mcpTools: [rule({ tool: 'export_csv', mode: 'write', pathArgs: [{ key: 'file', access: 'write' }] })],
    });
    // Вне плана — отказ planScope, ровно как у Write.
    const outside = evaluate(call('export_csv', { file: 'src/b.ts' }), c);
    ok(!outside.ok);
    strictEqual(outside.policy, 'planScope');

    // Внутри плана — проходит.
    strictEqual(evaluate(call('export_csv', { file: 'src/a.ts' }), c).ok, true);

    // Запрещённая категория остаётся запрещённой и через MCP.
    const secret = evaluate(call('export_csv', { file: '.env' }), c);
    ok(!secret.ok);
    strictEqual(secret.policy, 'denyList');
  });

  it('цели записи — только объявленные; иначе null, а не пустой список', () => {
    const declared = ctx({
      mcpTools: [rule({ tool: 'export_csv', mode: 'write', pathArgs: [{ key: 'file', access: 'write' }] })],
    });
    const bare = ctx({ mcpTools: [rule({ tool: 'delete_asset', mode: 'write' })] });

    strictEqual(writeTargetPaths(call('export_csv', { file: 'src/a.ts' }), declared)?.[0], 'src/a.ts');
    // `[]` читалось бы в панели как «посчитано: не пишет никуда» — для delete_asset это ложь.
    strictEqual(writeTargetPaths(call('delete_asset'), bare), null);
  });

  it('правило read с записывающим путём считается write — конфигу тут не доверяем', () => {
    const c = ctx({
      mcpTools: [rule({ tool: 'import_texture', mode: 'read', pathArgs: [{ key: 'file', access: 'write' }] })],
      allowedTools: ['McpRead'],
    });
    ok(!evaluate(call('import_texture', { file: 'src/a.ts' }), c).ok);
  });
});

describe('права на MCP выдаёт конфиг, а не определение этапа', () => {
  // Дыра, найденная живым прогоном: инструменты модели выдавались, вызов доходил до
  // политики и отклонялся ею — прав `McpRead`/`McpWrite` не выдавал никто, потому что
  // `stages.ts` общий для всех проектов и про MCP не знает.
  it('правило read требует McpRead, правило write — McpWrite', () => {
    const onlyRead = ctx({
      mcpTools: [rule({ tool: 'pie_status', mode: 'read' })],
      allowedTools: ['Read'],
    });
    ok(!evaluate(call('pie_status'), onlyRead).ok, 'без McpRead читающий вызов не проходит');

    const withRead = ctx({
      mcpTools: [rule({ tool: 'pie_status', mode: 'read' })],
      allowedTools: ['Read', 'McpRead'],
    });
    strictEqual(evaluate(call('pie_status'), withRead).ok, true);
  });

  it('класс правила считается одинаково правами и политикой', () => {
    // `read` с записывающим аргументом-путём — на деле `write`: если права выдать по
    // объявленному классу, а политика посчитает по фактическому, вызов будет отклонён
    // при формально выданном праве.
    const r = rule({
      tool: 'import_texture',
      mode: 'read',
      pathArgs: [{ key: 'file', access: 'write' }],
    });
    strictEqual(effectiveMode(r), 'write');
  });
});

describe('гейт одобрения: MCP', () => {
  const gate = (): ApprovalGate => new ApprovalGate({ onPending: () => {}, onResolved: () => {} });

  const ask = (g: ApprovalGate, c: NormalizedCall, over: Partial<PolicyContext>) =>
    g.request({
      runId: 'r1',
      stage: 'chunk',
      requestId: `id-${Math.random()}`,
      toolName: `mcp__unreal__${c.kind === 'mcp' ? c.tool : 'x'}`,
      rawInput: {},
      call: c,
      ctx: ctx(over),
    });

  it('читающий вызов проходит без шага человека', async () => {
    const d = await ask(gate(), call('pie_status'), { mcpTools: [rule()] });
    strictEqual(d.allowed && d.by, 'auto');
  });

  it('изменяющий вызов не автоодобряется правилом «остальное»', async () => {
    const g = gate();
    g.setAutoApprove('r1', 'chunk', { planWrites: true, bash: true, rest: true, mcpWrites: false });

    // Промис одобрения не резолвится сам: проверяем, что вызов ВСТАЛ в очередь, а не
    // проскочил. Ждём такт цикла событий — путь до очереди асинхронный (политика,
    // проверка симлинков, предпросмотр), и синхронная проверка увидела бы пустую очередь
    // независимо от исхода, то есть проходила бы всегда.
    const pending = ask(g, call('spawn_actor'), {
      mcpTools: [rule({ tool: 'spawn_actor', mode: 'write' })],
    });
    await new Promise((r) => setImmediate(r));
    const queued = g.list().some((p) => p.call.kind === 'mcp' && p.call.tool === 'spawn_actor');
    ok(queued);

    // Прибираем за собой: иначе промис висит до конца прогона тестов.
    g.cancelRun('r1', 'конец теста');
    await pending;
  });

  it('свой флаг mcpWrites изменяющий вызов автоодобряет', async () => {
    const g = gate();
    g.setAutoApprove('r1', 'chunk', { planWrites: false, bash: false, rest: false, mcpWrites: true });
    const d = await ask(g, call('spawn_actor'), {
      mcpTools: [rule({ tool: 'spawn_actor', mode: 'write' })],
    });
    strictEqual(d.allowed && d.by, 'auto');
  });

  it('правка аргументов оператором не может подменить сервер и инструмент', () => {
    // Имя приходит отдельно от аргументов, и `normalize` берёт сервер с инструментом
    // именно из него: правкой rawInput читающий вызов в изменяющий не превратить.
    const edited = normalize('mcp__unreal__pie_status', { force: true });
    ok(edited.kind === 'mcp');
    strictEqual(edited.server, 'unreal');
    strictEqual(edited.tool, 'pie_status');
  });
});
