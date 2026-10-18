/**
 * `runState.ts` — машинное состояние прогона для дашборда: pid, рабочая копия, отметки
 * этапов, остановка и «результат записан».
 */

import { deepStrictEqual, ok, strictEqual } from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { BENCH_RUN_STATE_FILE } from '@sdlc-runner/shared';
import type { BenchRunState } from '@sdlc-runner/shared';

import { createRunStateWriter } from '../src/runState.ts';

const dir = mkdtempSync(join(tmpdir(), 'sdlc-runstate-test-'));
after(() => rmSync(dir, { recursive: true, force: true }));

const read = (): BenchRunState => JSON.parse(readFileSync(join(dir, BENCH_RUN_STATE_FILE), 'utf8')) as BenchRunState;

describe('createRunStateWriter', () => {
  it('пишет шапку сразу, этапы по событиям и конец с признаком результата', () => {
    const w = createRunStateWriter(dir, {
      slug: 's',
      model: 'm',
      task: 't',
      pid: 123,
      workspace: 'C:/ws',
      startedAt: '2026-09-25T00:00:00.000Z',
      mode: { kind: 'stage', stage: 'chunk' },
      routes: { chunk: 'm' },
      measured: ['chunk'],
      startStage: 'chunk',
      currencies: { chunk: 'USD' },
    });
    after(() => w.close());
    strictEqual(read().pid, 123);
    ok(read().host !== '');
    strictEqual(read().startStage, 'chunk');
    strictEqual(read().end, null);

    w.onEvent({ type: 'stage_started', runId: 'r', stage: 'chunk', flow: 'loop', provider: 'p', model: 'm', chunk: 1, attempt: 2 });
    w.onEvent({ type: 'stage_done', runId: 'r', stage: 'chunk', ok: false, note: 'артефакт не заполнен' });
    deepStrictEqual(
      read().stages.map((s) => [s.stage, s.kind, s.attempt, s.note ?? null]),
      [
        ['chunk', 'start', 2, null],
        ['chunk', 'fail', 2, 'артефакт не заполнен'],
      ],
    );

    // Этап, упавший исключением (error без stage_done), закрывается отметкой провала.
    w.onEvent({ type: 'stage_started', runId: 'r', stage: 'verify', flow: 'sdk', provider: 'p', model: 'm', chunk: 1, attempt: 2 });
    w.onEvent({ type: 'error', runId: 'r', stage: 'verify', message: 'провайдер: 500' });
    strictEqual(read().stages.at(-1)?.kind, 'fail');
    strictEqual(read().stages.at(-1)?.note, 'этап упал: провайдер: 500');
    // Отказ входа (error без открытого этапа) отметкой не становится.
    const before = read().stages.length;
    w.onEvent({ type: 'error', runId: 'r', stage: 'handoff', message: 'нет вердикта' });
    strictEqual(read().stages.length, before);

    w.stopped('blocked', null);
    strictEqual(read().end?.stopped, 'blocked');
    strictEqual(read().resultWritten, false);
    w.resultWritten();
    strictEqual(read().resultWritten, true);
  });
});
