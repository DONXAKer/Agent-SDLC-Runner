/**
 * `dashboard/benchProgress.ts` — прогоны стенда без результата: файл состояния
 * (`run-state.json`, контракт `BenchRunState`) и запасной путь по логу хода.
 */

import { deepStrictEqual, ok, strictEqual } from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { BENCH_HEARTBEAT_MS, BENCH_RUN_STATE_FILE } from '@sdlc-runner/shared';
import type { BenchRunState } from '@sdlc-runner/shared';

import {
  STALE_MS,
  fromRunState,
  parseProgressLog,
  processAlive,
  progressCard,
  progressOutcome,
  progressStages,
  readRunProgress,
  runningStage,
} from '../src/dashboard/benchProgress.ts';
import type { LivenessProbe } from '../src/dashboard/benchProgress.ts';

const LOG = [
  '# s3-x · модель ollama:gpt-oss · задача vat-rounding · 2026-09-25T08:05:25.634Z',
  '#   intent   claude-sdk:haiku',
  '#   chunk    ollama:gpt-oss   (под измерением)',
  '#   verify   claude-sdk:opus',
  '',
  '▶ 11:05:25 chunk — ollama:gpt-oss (chunk 1, попытка 1, окно 32 768)',
  '  ⚠ форма разложена под артефакт C:\\Users\\R\\AppData\\Local\\Temp\\sdlc-bench-snap-A9f7dd\\.sdlc\\s3-x\\chunk-1-journal.md — этап…',
  '■ 11:09:30 chunk ✅ — запросов к модели 15',
  '',
  '▶ 11:09:31 verify — claude-sdk:opus (chunk 1, попытка 2)',
].join('\n');

function state(over: Partial<BenchRunState> = {}): BenchRunState {
  return {
    version: 1,
    slug: 's3-x',
    model: 'ollama:gpt-oss',
    task: 'vat-rounding',
    pid: 4242,
    host: 'this-host',
    heartbeatAt: new Date().toISOString(),
    workspace: 'C:/tmp/sdlc-bench-A',
    startedAt: '2026-09-25T08:05:25.634Z',
    mode: { kind: 'stage', stage: 'chunk' },
    startStage: 'explore',
    routes: { chunk: 'ollama:gpt-oss' },
    currencies: { chunk: 'USD' },
    measured: ['chunk'],
    stages: [
      { stage: 'chunk', kind: 'start', at: 't', chunk: 1, attempt: 1 },
      { stage: 'chunk', kind: 'ok', at: 't', chunk: 1, attempt: 1 },
      { stage: 'verify', kind: 'start', at: 't', chunk: 1, attempt: 3 },
    ],
    end: null,
    resultWritten: false,
    snapshot: null,
    ...over,
  };
}

const alive: LivenessProbe = { pidAlive: () => true, host: 'this-host' };
const dead: LivenessProbe = { pidAlive: () => false, host: 'this-host' };
const elsewhere: LivenessProbe = { pidAlive: () => false, host: 'другая-машина' };

describe('жизнь процесса прогона', () => {
  it('pid жив и пульс свежий — идёт; pid занят чужим процессом, но пульс старый — оборван', () => {
    const now = Date.now();
    ok(processAlive(fromRunState(state()), 0, now, alive));
    const stale = fromRunState(state({ heartbeatAt: new Date(now - 4 * BENCH_HEARTBEAT_MS).toISOString() }));
    ok(!processAlive(stale, 0, now, alive), 'переиспользованный pid без пульса — не жизнь');
    ok(!processAlive(fromRunState(state()), 0, now, dead));
  });

  it('на чужой машине pid ничего не значит — судит пульс', () => {
    const now = Date.now();
    ok(processAlive(fromRunState(state()), 0, now, elsewhere));
  });

  it('без файла состояния — давность правки лога', () => {
    const p = parseProgressLog(LOG)!;
    const now = Date.now();
    ok(processAlive(p, now - 60_000, now));
    ok(!processAlive(p, now - STALE_MS - 1, now));
  });
});

describe('исход и этапы по файлу состояния', () => {
  it('идёт / оборван / дописывает итоги / снимок', () => {
    const now = Date.now();
    deepStrictEqual(progressOutcome(fromRunState(state()), 0, now, alive), { running: true, status: 'open', stopped: 'идёт' });
    strictEqual(progressOutcome(fromRunState(state()), 0, now, dead).status, 'aborted');
    const ended = fromRunState(state({ end: { at: 't', stopped: 'handoff', verdict: 'continue' } }));
    ok(progressOutcome(ended, 0, now, alive).stopped.startsWith('дописывает итоги'));
    strictEqual(progressOutcome(ended, 0, now, dead).status, 'done');
    const snap = fromRunState(state({ end: { at: 't', stopped: 'snapshot-point', verdict: null }, snapshot: 'snap-1' }));
    deepStrictEqual(progressOutcome(snap, 0, now, dead), { running: false, status: 'unfinished', stopped: 'снимок «snap-1» сохранён' });
  });

  it('«из снимка» — только этапы до этапа старта драйвера, а не до замеряемого', () => {
    const info = fromRunState(state());
    strictEqual(runningStage(info), 'verify');
    deepStrictEqual(
      progressStages(info, true).map((s) => `${s.id}:${s.state}`),
      ['intent:done', 'explore:notStarted', 'ask:notStarted', 'plan:notStarted', 'chunk:done', 'verify:running', 'handoff:notStarted'],
    );
  });

  it('без рабочей копии chunk и попытка — из последней отметки', () => {
    const info = fromRunState(state());
    const card = progressCard(info, progressOutcome(info, 0, Date.now(), dead), { slug: 's3-x', mtimeMs: 0, base: null });
    strictEqual(card.attempt, 3);
  });
});

describe('запасной путь: лог хода', () => {
  it('шапка, маршруты, отметки этапов с номерами и рабочая копия', () => {
    const p = parseProgressLog(LOG)!;
    strictEqual(p.slug, 's3-x');
    deepStrictEqual(p.measured, ['chunk']);
    strictEqual(p.routes.verify, 'claude-sdk:opus');
    deepStrictEqual(
      p.marks.map((m) => `${m.stage}:${m.kind}:${m.attempt}`),
      ['chunk:start:1', 'chunk:ok:1', 'verify:start:2'],
    );
    strictEqual(p.workspace, 'C:\\Users\\R\\AppData\\Local\\Temp\\sdlc-bench-snap-A9f7dd');
    strictEqual(p.pid, null);
  });

  it('строка конца разбирается в остановку и вердикт', () => {
    const now = Date.now();
    const ended = parseProgressLog(`${LOG}\n\n# 11:20:00 остановка: snapshot-point · вердикт: — · 15 мин`)!;
    strictEqual(ended.stopped, 'snapshot-point');
    strictEqual(ended.verdict, null);
    strictEqual(progressOutcome(ended, now - STALE_MS - 1, now).status, 'unfinished');
    const failed = parseProgressLog(`${LOG}\n■ 11:10:00 verify ❌ — вердикт escalate`)!;
    strictEqual(progressStages(failed, false).find((s) => s.id === 'verify')?.note, 'вердикт escalate');
  });

  it('не лог хода прогона — null', () => {
    strictEqual(parseProgressLog('просто текст'), null);
  });
});

describe('readRunProgress', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sdlc-runprogress-test-'));
  after(() => rmSync(dir, { recursive: true, force: true }));

  it('нечитаемый файл состояния не прячет прогон — берётся лог', () => {
    const trace = join(dir, 's3-x');
    mkdirSync(trace, { recursive: true });
    writeFileSync(join(trace, BENCH_RUN_STATE_FILE), '{ битый');
    writeFileSync(join(trace, 'progress.log'), LOG);
    strictEqual(readRunProgress(trace)?.info?.slug, 's3-x');
  });

  it('запись ранней версии без end и routes разбирается', () => {
    const trace = join(dir, 'early');
    mkdirSync(trace, { recursive: true });
    const { end: _e, routes: _r, ...rest } = state();
    writeFileSync(join(trace, BENCH_RUN_STATE_FILE), JSON.stringify(rest));
    const info = readRunProgress(trace)?.info;
    strictEqual(info?.stopped, null);
    deepStrictEqual(info?.routes, {});
  });
});
