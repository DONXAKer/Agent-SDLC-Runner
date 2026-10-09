import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Script } from 'node:vm';
import { WitokPaths } from '../src/artifacts/paths.ts';
import { RunFlowRecorder, flowFromEvents, flowReadDenied, flowTextDiff, readFlowTrace, renderRunFlow } from '../src/run/runFlow.ts';
import type { PolicyContext, RunEvent } from '@sdlc-runner/shared';
import { evaluate } from '../src/policy/index.ts';
import { normalize } from '../src/exec/normalize.ts';
import { dumpExchange } from '../src/provider/rawLog.ts';
import { dashboardFlow } from '../src/dashboard/index.ts';

test('archive copies of protected data are denied across current and previous sessions', t => {
  const root = mkdtempSync(join(tmpdir(), 'flow-read-scope-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const paths = new WitokPaths(root, 'demo');
  const old = new RunFlowRecorder(paths, 'old'); old.record('model_request', { request: 'Скрытый авторский лист' }); old.writeHtml();
  const denied = flowReadDenied(paths, 'current');
  const ctx: PolicyContext = { projectRoot: root, sdlcDir: '.sdlc/demo', stage: 'verify', planFiles: null,
    protectedArtifacts: [], readOnlyRoots: [], allowedTools: ['Read', 'Grep', 'Glob'], mcpTools: [], readDenied: denied };
  for (const path of denied) assert.equal(evaluate(normalize('Read', { file_path: path }), ctx).ok, false, path);
  assert.equal(evaluate(normalize('Grep', { pattern: 'авторский', path: '.sdlc/demo', glob: '*.ndjson' }), ctx).ok, false);
  assert.equal(evaluate(normalize('Glob', { pattern: '**/*.html', path: '.sdlc/demo' }), ctx).ok, false);
  assert.equal(evaluate(normalize('Grep', { pattern: 'function', path: '.', glob: '*.ts' }), ctx).ok, true);
  assert.ok(denied.some(path => path.includes('/current/trace.ndjson')));
  assert.ok('ok' in dashboardFlow('ui', 'p', 'demo', [{ key: 'p', aliases: [], projectRoot: root }], []));
});

test('old event logs keep skipped, blocked, repeated and restarted stages separate', () => {
  const events: RunEvent[] = [
    { type: 'stage_started', runId: 'old', stage: 'explore', flow: 'loop', provider: 'local', model: 'test', chunk: 1, attempt: 1 },
    { type: 'stage_done', runId: 'old', stage: 'explore', ok: true, note: 'done' },
    { type: 'stage_done', runId: 'old', stage: 'ask', ok: true, note: 'Нет вопросов' },
    { type: 'error', runId: 'old', stage: 'plan', message: 'Блокер' },
    { type: 'error', runId: 'old', stage: 'plan', message: 'Повторный блокер' },
    { type: 'run_started', runId: 'new', slug: 'demo', profile: 'test', projectRoot: '.' },
    { type: 'stage_done', runId: 'new', stage: 'ask', ok: true, note: 'Нет вопросов' },
  ];
  const report = flowFromEvents(events, 'demo');
  const outcomes = report.entries.filter(e => e.kind === 'stage_done' || e.kind === 'error');
  assert.equal(new Set(outcomes.map(e => e.invocation)).size, 5);
  assert.equal(report.entries.filter(e => e.kind === 'stage_entered').length, 4);
  const explore = report.entries.find(e => e.kind === 'stage_started')!;
  assert.equal(report.entries.filter(e => e.invocation === explore.invocation && e.kind === 'error').length, 0);
  assert.equal(report.entries.find(e => e.kind === 'run_started')!.invocation, null);
});

test('dashboard opens a saved diagram or a labelled old archive and rejects traversal', t => {
  const root = mkdtempSync(join(tmpdir(), 'dashboard-flow-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const paths = new WitokPaths(root, 'demo'); const projects = [{ key: 'p', aliases: ['alias'], projectRoot: root }];
  mkdirSync(paths.runnerDir, { recursive: true });
  writeFileSync(paths.events, JSON.stringify({ type: 'stage_done', runId: 'test', stage: 'intent', ok: true, note: 'done' }) + '\n');
  const old = dashboardFlow('ui', 'alias', 'demo', projects, []); assert.ok('ok' in old); assert.match(old.ok, /archive_limit/);
  writeFileSync(join(paths.runnerDir, 'flow.html'), '<html>saved detailed flow</html>');
  assert.deepEqual(dashboardFlow('ui', 'p', 'demo', projects, []), { ok: '<html>saved detailed flow</html>' });
  assert.equal('error' in dashboardFlow('ui', 'p', '../outside', projects, []), true);
  assert.equal('error' in dashboardFlow('ui', 'missing', 'demo', projects, []), true);
  assert.equal('error' in dashboardFlow('unknown', 'p', 'demo', projects, []), true);
});

test('records before/after snapshots and preserves each repeated stage invocation', t => {
  const root = mkdtempSync(join(tmpdir(), 'run-flow-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const paths = new WitokPaths(root, 'demo'); const flow = new RunFlowRecorder(paths, 'run-1');
  writeFileSync(join(root, 'a.ts'), 'before\n');
  flow.event({ type: 'stage_started', runId: 'run-1', stage: 'chunk', flow: 'loop', provider: 'local', model: 'test', chunk: 1, attempt: 1 });
  flow.watch(['a.ts']); writeFileSync(join(root, 'a.ts'), 'after\n'); flow.changes('tool-1');
  flow.event({ type: 'stage_done', runId: 'run-1', stage: 'chunk', ok: false, note: 'retry' });
  flow.event({ type: 'stage_started', runId: 'run-1', stage: 'chunk', flow: 'loop', provider: 'local', model: 'test', chunk: 1, attempt: 2 });
  flow.watch(['new.ts']); writeFileSync(join(root, 'new.ts'), 'created\n'); flow.changes('tool-2');
  const html = flow.writeHtml(); assert.ok(existsSync(html)); assert.ok(existsSync(join(paths.runnerDir, 'flow.html')));
  const trace = readFlowTrace(join(flow.dir, 'trace.ndjson'));
  const changes = trace.entries.filter(e => e.kind === 'file_change').map(e => e.payload as { before: { text: string } | null; after: { text: string }; requestId: string });
  assert.equal(changes[0]!.before!.text, 'before\n'); assert.equal(changes[0]!.after.text, 'after\n');
  assert.equal(changes[1]!.before, null); assert.equal(changes[1]!.requestId, 'tool-2');
  const starts = trace.entries.filter(e => e.kind === 'stage_started'); assert.notEqual(starts[0]!.invocation, starts[1]!.invocation);
});

test('untrusted model/file content cannot escape the inert JSON block and executable JS parses', () => {
  const malicious = '</script><script>throw Error("injected")</script><img src=x onerror=alert(1)>';
  const html = renderRunFlow({ version: 1, runId: 'test', slug: malicious, entries: [{ id: '1', at: '', stage: 'intent', invocation: null,
    kind: 'decision_check', from: 'Модель', to: 'Рантайм', payload: { decision: malicious } }] });
  assert.equal(html.includes(malicious), false);
  const data = /<script id="flow-data" type="application\/json">([\s\S]*?)<\/script>/.exec(html)![1]!;
  assert.equal(JSON.parse(data).slug, malicious);
  const executable = /<script>\n([\s\S]*?)<\/script>/.exec(html)![1]!;
  assert.doesNotThrow(() => new Script(executable));
  assert.ok(!html.includes('src="http')); assert.match(executable, /textContent/);
});

test('HTML diagram executes offline, switches stages, filters changed decisions and searches file data', () => {
  class Element {
    children: Element[] = []; textContent = ''; id = ''; className = ''; value = ''; open = false;
    dataset: Record<string, string> = {}; onclick: (() => void) | null = null; oninput: (() => void) | null = null; onchange: (() => void) | null = null;
    classList = { toggle() {} };
    readonly tag: string;
    constructor(tag: string) { this.tag = tag; }
    append(...children: Element[]) { this.children.push(...children); }
    replaceChildren(...children: Element[]) { this.children = children; }
    querySelectorAll(tag: string): Element[] { return this.children.flatMap(child => [...(child.tag === tag ? [child] : []), ...child.querySelectorAll(tag)]); }
  }
  const html = renderRunFlow({ version: 1, slug: 'demo', runId: 'test', entries: [
    { id: 'start-1', at: '', stage: 'plan', invocation: 'one', kind: 'stage_entered', from: 'Рантайм', to: 'Рантайм', payload: {} },
    { id: 'decision', at: '', stage: 'plan', invocation: 'one', kind: 'decision_check', from: 'Гипотеза', to: 'Основания', payload: { decision: 'Исправить источник', changed: true, status: 'ready' } },
    { id: 'start-2', at: '', stage: 'chunk', invocation: 'two', kind: 'stage_entered', from: 'Рантайм', to: 'Рантайм', payload: {} },
    { id: 'file', at: '', stage: 'chunk', invocation: 'two', kind: 'file_change', from: 'До', to: 'После', payload: { path: 'a.ts', before: { text: 'old' }, after: { text: 'new' }, diff: '-old\n+new' } },
  ] });
  const roots = new Map(['flow-data', 'title', 'meta', 'stats', 'stages', 'search', 'filter', 'expand', 'chain', 'timeline'].map(id => [id, new Element('div')]));
  roots.get('flow-data')!.textContent = /<script id="flow-data" type="application\/json">([\s\S]*?)<\/script>/.exec(html)![1]!;
  roots.get('filter')!.value = 'all';
  const document = { createElement: (tag: string) => new Element(tag), getElementById: (id: string) => roots.get(id) ?? [...roots.values()]
    .flatMap(root => root.querySelectorAll('details')).find(node => node.id === id),
    querySelectorAll: () => roots.get('timeline')!.querySelectorAll('details') };
  new Script(/<script>\n([\s\S]*?)<\/script>/.exec(html)![1]!).runInNewContext({ document });
  assert.equal(roots.get('stages')!.querySelectorAll('button').length, 3);
  assert.equal(roots.get('timeline')!.querySelectorAll('details').length, 4);
  roots.get('stages')!.querySelectorAll('button')[1]!.onclick!();
  assert.equal(roots.get('timeline')!.querySelectorAll('details').length, 2);
  roots.get('filter')!.value = 'decision'; roots.get('filter')!.onchange!();
  assert.equal(roots.get('timeline')!.querySelectorAll('details').length, 1);
  assert.match(roots.get('timeline')!.querySelectorAll('details')[0]!.className, /changed/);
  roots.get('stages')!.querySelectorAll('button')[0]!.onclick!(); roots.get('filter')!.value = 'all';
  roots.get('search')!.value = 'a.ts'; roots.get('search')!.oninput!();
  assert.equal(roots.get('timeline')!.querySelectorAll('details')[0]!.id, 'entry-file');
  roots.get('expand')!.onclick!(); assert.equal(roots.get('timeline')!.querySelectorAll('details')[0]!.open, true);
});

test('old archives label missing full requests and snapshots instead of inventing them', () => {
  const report = flowFromEvents([{ type: 'stage_started', runId: 'old', stage: 'intent', flow: 'loop', provider: 'local', model: 'test', chunk: 1, attempt: 1 },
    { type: 'stage_done', runId: 'old', stage: 'intent', ok: true, note: 'done' }], 'old');
  assert.equal(report.entries[0]!.kind, 'archive_limit');
  assert.equal(report.entries.filter(e => e.kind === 'file_change').length, 0);
  assert.equal(report.entries[1]!.invocation, report.entries[2]!.invocation);
});

test('file comparison isolates changed lines and handles creation/deletion', () => {
  assert.equal(flowTextDiff('first\nold\nlast', 'first\nnew\nlast'), '@@ -2,1 +2,1 @@\n-old\n+new');
  assert.equal(flowTextDiff('', 'created'), '@@ -0,0 +1,1 @@\n+created');
  assert.equal(flowTextDiff('deleted', ''), '@@ -1,1 +0,0 @@\n-deleted');
  assert.equal(flowTextDiff('same', 'same'), '');
});

test('run observer captures exact exchanges even when optional benchmark raw logs are disabled', () => {
  let captured: unknown;
  const exchange = { provider: 'local', model: 'test', request: { messages: [{ role: 'user', content: 'actual input' }] }, response: '{"result":1}', status: 200, durationMs: 10 };
  dumpExchange({ slug: 'flow-test', stage: 'plan', mode: 'decisionCheck', onExchange: value => { captured = value; } }, exchange);
  assert.deepEqual(captured, exchange);
});
