/**
 * `dashboard/bench.ts` — прогоны стенда в дашборде: свой разбор `result.json` (стенд сервер
 * не импортирует наоборот), кэш по mtime, пропуск чужих файлов каталога результатов.
 */

import { deepStrictEqual, ok, strictEqual } from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { BenchIndex, benchCard, benchStatus, parseBenchResult } from '../src/dashboard/bench.ts';
import { benchDetail } from '../src/dashboard/detail.ts';
import { dashboardArtifact, dashboardDetail, dashboardList } from '../src/dashboard/index.ts';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'sdlc-dash-bench-test-')));
after(() => rmSync(root, { recursive: true, force: true }));

const results = join(root, 'results');
mkdirSync(results, { recursive: true });

function result(slug: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    run: {
      slug,
      model: 'ollama:qwen',
      task: 'vat-rounding',
      mode: { kind: 'stage', stage: 'chunk' },
      routes: { chunk: 'ollama:qwen', verify: 'claude-sdk:opus' },
      currencies: { chunk: 'USD', verify: 'USD' },
      startedAt: '2026-09-20T10:00:00.000Z',
      finishedAt: '2026-09-20T10:30:00.000Z',
    },
    driver: {
      stages: [
        { stage: 'chunk', chunk: 1, attempt: 1, ok: true, note: '', blockers: [], timedOut: false, skipped: false },
        { stage: 'verify', chunk: 1, attempt: 1, ok: false, note: 'красный', blockers: [], timedOut: false, skipped: false },
        { stage: 'chunk', chunk: 1, attempt: 2, ok: true, note: '', blockers: [], timedOut: false, skipped: false },
        { stage: 'verify', chunk: 1, attempt: 2, ok: true, note: '', blockers: [], timedOut: false, skipped: false },
      ],
      finalVerdict: { passed: true, action: 'continue', reasons: [] },
      stopped: 'handoff',
    },
    metrics: { stages: [{ stage: 'chunk', runs: 2, usage: { inputTokens: 100, outputTokens: 10, costUsd: 0.5 }, durationMs: 1000 }] },
    ...over,
  };
}

writeFileSync(join(results, 'x.json'), JSON.stringify(result('x')));
writeFileSync(join(results, 'x.report.md'), '# отчёт\n');
writeFileSync(join(results, 'noise.log'), 'лог серии\n');
writeFileSync(join(results, 'broken.json'), '{ не json');
writeFileSync(join(results, 'y.report.md'), '# отчёт без результата\n');
mkdirSync(join(root, 'traces', 'x'), { recursive: true });
writeFileSync(
  join(root, 'traces', 'x', 'events.ndjson'),
  [
    { type: 'run_started', runId: 'r1', slug: 'x', profile: 'p', projectRoot: '/tmp/w' },
    { type: 'stage_started', runId: 'r1', stage: 'chunk', flow: 'loop', provider: 'ollama', model: 'qwen', chunk: 1, attempt: 1 },
    { type: 'assistant_text', runId: 'r1', stage: 'chunk', text: 'правлю' },
    { type: 'stage_done', runId: 'r1', stage: 'chunk', ok: true, note: '' },
  ]
    .map((e) => JSON.stringify(e))
    .join('\n'),
);

describe('BenchIndex', () => {
  const index = new BenchIndex(root);

  it('одна карточка на результат; логи и отчёты без результата пропущены, битый — счётчиком', () => {
    const l = index.list();
    strictEqual(l.available, true);
    deepStrictEqual(
      l.cards.map((c) => c.ref.slug),
      ['x'],
    );
    strictEqual(l.skipped, 1);
    const c = l.cards[0]!;
    strictEqual(c.ref.source, 'bench');
    strictEqual(c.ref.project, 'results');
    strictEqual(c.status, 'done');
    strictEqual(c.bench?.hasTrace, true);
    strictEqual(c.bench?.hasReport, true);
    strictEqual(c.usage?.costUsd, 0.5);
    // Повторы chunk↔verify: судит последняя запись verify — зелёная.
    strictEqual(c.stages.find((s) => s.id === 'verify')?.state, 'done');
    strictEqual(c.stages.find((s) => s.id === 'plan')?.note, 'из снимка');
  });

  it('неизменный файл не пересобирается; изменённый — да', () => {
    const first = index.card('x');
    index.refresh(Date.now(), true);
    strictEqual(index.card('x'), first);
    writeFileSync(join(results, 'x.json'), JSON.stringify(result('x', { driver: { stages: [], finalVerdict: null, stopped: 'blocked' } })));
    index.refresh(Date.now(), true);
    ok(index.card('x') !== first);
    strictEqual(index.card('x')?.status, 'aborted');
    writeFileSync(join(results, 'x.json'), JSON.stringify(result('x')));
    index.refresh(Date.now(), true);
  });

  it('детали подхватывают трассу; файлы — только из словаря', () => {
    const d = benchDetail(index, 'x');
    ok(d !== null);
    strictEqual(d.stages.find((s) => s.id === 'chunk')?.lastRun?.assistantText, 'правлю');
    strictEqual(d.stages.find((s) => s.id === 'verify')?.benchRecord?.ok, true);
    deepStrictEqual(
      d.artifacts.map((a) => a.name),
      ['result.json', 'report.md', 'events.ndjson'],
    );
    const report = dashboardArtifact('bench', 'results', 'x', 'report.md', [], [index]);
    ok('ok' in report && report.ok.text.startsWith('# отчёт'));
    const bad = dashboardArtifact('bench', 'results', 'x', '../x.json', [], [index]);
    ok('error' in bad && bad.code === 404);
    const unknown = dashboardArtifact('bench', 'results', 'y', 'report.md', [], [index]);
    ok('error' in unknown && unknown.code === 404, 'слаг без результата адресуется');
  });

  it('архив — второй индекс той же раскладки: свой проект в адресе, чужой проект прогон не находит', () => {
    const archiveDir = join(root, 'archive');
    mkdirSync(join(archiveDir, 'results'), { recursive: true });
    writeFileSync(join(archiveDir, 'results', 'old.json'), JSON.stringify(result('old')));
    writeFileSync(join(archiveDir, 'results', 'old.report.md'), '# старый отчёт\n');
    const archive = new BenchIndex(archiveDir, 'archive');
    const l = dashboardList([], [], [index, archive]);
    deepStrictEqual(
      l.cards.map((c) => `${c.ref.project}/${c.ref.slug}`).sort(),
      ['archive/old', 'results/x'],
    );
    const inArchive = dashboardArtifact('bench', 'archive', 'old', 'report.md', [], [index, archive]);
    ok('ok' in inArchive && inArchive.ok.text.startsWith('# старый'));
    const wrong = dashboardArtifact('bench', 'results', 'old', 'report.md', [], [index, archive]);
    ok('error' in wrong && wrong.code === 404);
    ok('ok' in dashboardDetail('bench', 'archive', 'old', [], [], [index, archive]));
    ok('error' in dashboardDetail('bench', 'нет', 'x', [], [], [index, archive]));
  });

  it('каталога нет — не ошибка, а пустой список', () => {
    const l = new BenchIndex(join(root, 'нет-такого')).list();
    deepStrictEqual(l, { cards: [], skipped: 0, available: false });
  });
});

describe('parseBenchResult / benchStatus', () => {
  it('не результат стенда — null', () => {
    strictEqual(parseBenchResult({ foo: 1 }), null);
    strictEqual(parseBenchResult([]), null);
  });

  it('рубли с долларами в одну сумму не складываются', () => {
    const r = parseBenchResult(
      result('m', {
        run: { ...(result('m')['run'] as object), currencies: { chunk: 'RUB', verify: 'USD' } },
        metrics: {
          stages: [
            { stage: 'chunk', runs: 1, usage: { costUsd: 10 }, durationMs: 1 },
            { stage: 'verify', runs: 1, usage: { costUsd: 1 }, durationMs: 1 },
          ],
        },
      }),
    )!;
    const c = benchCard(r, { mtimeMs: 0, hasTrace: false, hasReport: false });
    strictEqual(c.usage?.costUsd, null);
    strictEqual(c.currency, undefined);
  });

  it('статус прогона словарём статусов витка', () => {
    const base = parseBenchResult(result('s'))!;
    strictEqual(benchStatus(base), 'done');
    strictEqual(benchStatus({ ...base, driver: { ...base.driver, finalVerdict: { passed: false, action: 'retry', reasons: [] } } }), 'aborted');
    strictEqual(benchStatus({ ...base, driver: { ...base.driver, stopped: 'snapshot-point' } }), 'unfinished');
    strictEqual(benchStatus({ ...base, driver: { ...base.driver, stopped: 'escalate' } }), 'aborted');
  });
});
