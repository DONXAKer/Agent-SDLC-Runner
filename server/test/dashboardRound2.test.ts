/**
 * Исправления второго раунда ревью дашборда: принадлежность прогона своему `runId`, отказ
 * входа против старого провала, инкрементальная сводка ленты, хвост файла, словарь служебных
 * имён из `paths.ts`, проверка slug, форма тела ответа, виновник пустой секции задачи,
 * починка оборванной строки ленты.
 */

import { deepStrictEqual, ok, strictEqual } from 'node:assert/strict';
import { appendFileSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import type { DashboardResponse, RunEvent } from '@sdlc-runner/shared';

import { writeArtifact } from '../src/artifacts/artifact.ts';
import { WitokPaths } from '../src/artifacts/paths.ts';
import { allowedWitokName, readCapped } from '../src/dashboard/artifactAccess.ts';
import { indexEvents, readEventSummary } from '../src/dashboard/events.ts';
import { badWitokSlug, dashboardBody } from '../src/dashboard/index.ts';
import { appendEvent } from '../src/eventLog.ts';
import { entryProblems } from '../src/run/stages/entry.ts';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'sdlc-dash-r2-test-')));
after(() => rmSync(root, { recursive: true, force: true }));

const line = (e: RunEvent): string => `${JSON.stringify(e)}\n`;

describe('лента: прогон принадлежит своему runId', () => {
  it('новый run_started закрывает незакрытый прогон умершего процесса; отказ нового входа — не «упал»', () => {
    const idx = indexEvents([
      { type: 'run_started', runId: 'A', slug: 's', profile: 'p', projectRoot: root },
      { type: 'stage_started', runId: 'A', stage: 'chunk', flow: 'loop', provider: 'x', model: 'y', chunk: 1, attempt: 1 },
      { type: 'run_started', runId: 'B', slug: 's', profile: 'p', projectRoot: root },
      { type: 'prompt_prepared', runId: 'B', stage: 'chunk', prompt: { presetNote: null, system: 'ПРЕДПРОСМОТР', user: '', tools: [], editedByOperator: false } },
      { type: 'error', runId: 'B', stage: 'chunk', message: 'нет плана' },
    ]);
    strictEqual(idx.open.size, 0);
    strictEqual(idx.openErrors.size, 0);
    strictEqual(idx.stages.get('chunk')?.prompt, null, 'предпросмотр нового Run — не промпт упавшего прогона');
    deepStrictEqual(idx.stages.get('chunk')?.errors, ['не стартовал: нет плана']);
    // Отказ входа снимает отметку провала: этап не «провален», а не пускается.
    strictEqual(idx.failed.has('chunk'), false);
  });

  it('отказ входа после провала снимает старую отметку провала', () => {
    const idx = indexEvents([
      { type: 'stage_started', runId: 'A', stage: 'plan', flow: 'loop', provider: 'x', model: 'y', chunk: 1, attempt: 1 },
      { type: 'stage_done', runId: 'A', stage: 'plan', ok: false, note: 'артефакт не заполнен' },
      { type: 'error', runId: 'A', stage: 'plan', message: 'нет разведки' },
    ]);
    strictEqual(idx.failed.has('plan'), false);
  });
});

describe('сводка ленты дочитывается по смещению', () => {
  it('недописанная строка ждёт; дописанная учитывается; версия растёт', () => {
    const path = join(root, 'events.ndjson');
    writeFileSync(path, line({ type: 'run_started', runId: 'A', slug: 's', profile: 'p', projectRoot: root }));
    const first = readEventSummary(path);
    deepStrictEqual(first.runIds, ['A']);
    // Половина строки — запись идёт прямо сейчас.
    const next = line({ type: 'stage_started', runId: 'A', stage: 'intent', flow: 'loop', provider: 'x', model: 'y', chunk: 1, attempt: 1 });
    appendFileSync(path, next.slice(0, 20));
    strictEqual(readEventSummary(path).stagesRun, 0);
    appendFileSync(path, next.slice(20));
    const s = readEventSummary(path);
    strictEqual(s.stagesRun, 1);
    ok(s.version > first.version);
    ok(s.open.has('intent'));
  });
});

describe('чтение файла с потолком', () => {
  it('хвост начинается с границы строки', () => {
    const path = join(root, 'tail.log');
    writeFileSync(path, `${'a'.repeat(50)}\nвторая строка\nтретья\n`);
    const r = readCapped(path, 30, 'tail');
    ok(r.truncated && r.tail);
    ok(!r.text.startsWith('a'), r.text);
    ok(r.text.endsWith('третья\n'));
  });
});

describe('словарь служебных имён — из paths.ts', () => {
  it('отчёты раннера по номерам из имени', () => {
    for (const n of ['.runner/iterations.md', '.runner/metrics.md', '.runner/chunk-2-attempt-3-steps.md', '.runner/verification-report-1-attempt-2-r1.md', '.intent-sections.json', 'iterations.md']) {
      ok(allowedWitokName(n), n);
    }
    for (const n of ['.runner/metrics.json', '.runner/chunk-2-steps.md', '.runner/verification-report-1-attempt-2-r0.md']) {
      ok(!allowedWitokName(n), n);
    }
  });
});

describe('slug адреса', () => {
  it('`..` внутри имени — не сегмент пути', () => {
    strictEqual(badWitokSlug('v1..v2'), null);
    ok(badWitokSlug('..') !== null);
    ok(badWitokSlug('a/b') !== null);
  });
});

describe('тело ответа списка', () => {
  it('ключи тела = ключи ответа; сериализация стабильна', () => {
    const r: DashboardResponse = { serverNow: 1, cards: [], bench: { available: false, skipped: 0 } };
    const body = JSON.parse(dashboardBody(r).body) as Record<string, unknown>;
    deepStrictEqual(Object.keys(body).sort(), Object.keys(r).sort());
  });
});

describe('виновник пустой секции задачи', () => {
  it('вход plan отклонён только из-за «Что придётся тронуть» — виноват explore', () => {
    const ctx = { paths: new WitokPaths(root, 'touch'), chunk: 1, attempt: 1 };
    writeArtifact(ctx.paths.intent, '# Задача: сделать\n\n**Контур:** полный\n\n## Что придётся тронуть\n\n- ‹заполнит разведка›\n');
    const p = entryProblems('plan', ctx, null).find((x) => x.text.includes('незаполненных мест'));
    strictEqual(p?.blamed, 'explore');
  });
});

describe('лента: оборванная строка', () => {
  it('первая запись процесса начинается с новой строки, если прошлая оборвана', () => {
    const paths = new WitokPaths(root, 'torn');
    writeArtifact(paths.events, '{"type":"run_started","runId":"A"');
    appendEvent(root, 'torn', { type: 'run_started', runId: 'B', slug: 'torn', profile: 'p', projectRoot: root });
    const lines = readFileSync(paths.events, 'utf8').split('\n').filter((l) => l !== '');
    strictEqual(lines.length, 2);
    strictEqual((JSON.parse(lines[1]!) as { runId: string }).runId, 'B');
  });
});
