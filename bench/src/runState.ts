/**
 * Машинное состояние прогона для дашборда — `traces/<slug>/run-state.json`
 * (контракт `BenchRunState` в `shared`).
 *
 * `progress.log` пишется для человека, а дашборду нужны факты: жив ли процесс, где рабочая
 * копия, на каком этапе прогон и записан ли уже результат. Файл перезаписывается целиком
 * на каждое изменение — он маленький, а читатель не должен видеть половину записи.
 *
 * Жизнь процесса подтверждает пульс (`heartbeatAt`), а не только pid: Windows быстро
 * раздаёт освободившиеся pid, и убитый прогон, чей pid занял чужой процесс, иначе
 * выглядел бы живым вечно.
 */

import { renameSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';

import { BENCH_HEARTBEAT_MS, BENCH_RUN_STATE_FILE } from '@sdlc-runner/shared';
import type { BenchRunState, RunEvent } from '@sdlc-runner/shared';

export interface RunStateWriter {
  onEvent(e: RunEvent): void;
  stopped(stopped: string, verdict: string | null): void;
  exception(message: string): void;
  resultWritten(): void;
  snapshot(name: string): void;
  /** Остановить пульс — процесс прогона закончил работу с этим состоянием. */
  close(): void;
}

type Init = Omit<BenchRunState, 'version' | 'stages' | 'end' | 'resultWritten' | 'snapshot' | 'host' | 'heartbeatAt'>;

/** Попыток переименования: на Windows `rename` поверх файла, открытого читателем, даёт EPERM. */
const RENAME_TRIES = 5;

export function createRunStateWriter(dir: string, init: Init): RunStateWriter {
  const now = (): string => new Date().toISOString();
  const state: BenchRunState = {
    version: 1,
    ...init,
    host: hostname(),
    heartbeatAt: now(),
    stages: [],
    end: null,
    resultWritten: false,
    snapshot: null,
  };
  const path = join(dir, BENCH_RUN_STATE_FILE);
  const flush = (): void => {
    const text = `${JSON.stringify(state, null, 2)}\n`;
    const tmp = `${path}.tmp`;
    try {
      writeFileSync(tmp, text, 'utf8');
    } catch {
      return; // Состояние для дашборда — наблюдаемость, не условие прогона.
    }
    // Через временный файл: читатель не должен поймать файл посреди записи. Финальные
    // записи (конец, результат, снимок) — последние, следующей не будет: их потеря из-за
    // занятого файла превращала штатный конец в «оборван». Отсюда повтор и запасной путь.
    for (let i = 0; i < RENAME_TRIES; i++) {
      try {
        renameSync(tmp, path);
        return;
      } catch {
        const until = Date.now() + 20 * (i + 1);
        while (Date.now() < until) {
          /* короткое ожидание: читатель отпустит файл */
        }
      }
    }
    try {
      writeFileSync(path, text, 'utf8');
    } catch {
      /* наблюдаемость, не условие прогона */
    }
  };
  flush();
  const beat = setInterval(() => {
    state.heartbeatAt = now();
    flush();
  }, BENCH_HEARTBEAT_MS);
  // Пульс не держит процесс живым: прогон заканчивается, когда закончилась работа.
  beat.unref();

  /** Незакрытый этап — последний начатый, чьей отметки конца ещё нет. */
  const openStage = (stage: string): { chunk: number; attempt: number } | null => {
    for (let i = state.stages.length - 1; i >= 0; i--) {
      const m = state.stages[i]!;
      if (m.stage !== stage) continue;
      return m.kind === 'start' ? { chunk: m.chunk, attempt: m.attempt } : null;
    }
    return null;
  };

  return {
    onEvent(e) {
      if (e.type === 'stage_started') {
        state.stages.push({ stage: e.stage, kind: 'start', at: now(), chunk: e.chunk, attempt: e.attempt });
        flush();
      } else if (e.type === 'stage_done') {
        const last = [...state.stages].reverse().find((s) => s.stage === e.stage);
        state.stages.push({
          stage: e.stage,
          kind: e.ok ? 'ok' : 'fail',
          at: now(),
          chunk: last?.chunk ?? 1,
          attempt: last?.attempt ?? 1,
          ...(e.note === '' ? {} : { note: e.note.slice(0, 500) }),
        });
        flush();
      } else if (e.type === 'error' && e.stage !== null) {
        // Этап, упавший исключением, закрывается рантаймом только `error` — без
        // `stage_done`. Без этой отметки он оставался бы «идущим» до конца прогона. Ошибка
        // до `stage_started` (отказ входа) открытого этапа не имеет и отметкой не становится.
        const open = openStage(e.stage);
        if (open === null) return;
        state.stages.push({ stage: e.stage, kind: 'fail', at: now(), ...open, note: `этап упал: ${e.message}`.slice(0, 500) });
        flush();
      }
    },
    stopped(stopped, verdict) {
      state.end = { at: now(), stopped, verdict };
      flush();
    },
    exception(message) {
      // Исключение после записанной остановки — сбой дописывания итогов, а не прогона.
      if (state.end === null) state.end = { at: now(), stopped: 'exception', verdict: null, message: message.slice(0, 500) };
      else state.end = { ...state.end, message: `итоги не дописаны: ${message}`.slice(0, 500) };
      flush();
    },
    resultWritten() {
      state.resultWritten = true;
      flush();
    },
    snapshot(name) {
      state.snapshot = name;
      flush();
    },
    close() {
      clearInterval(beat);
    },
  };
}
