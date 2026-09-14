/**
 * Преполётный тест (`src/preflight.ts`) — герметично: сеть и дочерние процессы
 * подменяются через `PreflightDeps`, файловые проверки идут по настоящему bench/.
 */

import { ok, strictEqual } from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { loadConfig } from '../../server/src/config/load.ts';
import type { ProbeReport } from '../../server/src/probe.ts';
import { spawnNode } from '../src/nodeTest.ts';
import { parseArgs } from '../src/options.ts';
import type { BenchOptions } from '../src/options.ts';
import { formatPreflight, preflightExitCode, runPreflight } from '../src/preflight.ts';
import type { PreflightDeps, PreflightReport } from '../src/preflight.ts';

const MODEL = 'ollama:qwen3.5:4b-ctx16k';

function opts(argv: readonly string[]): BenchOptions {
  return parseArgs(argv);
}

const greenProbe: PreflightDeps['probe'] = async ({ cases }) => ({
  model: 'm',
  cases: (cases ?? []).map((c) => ({ name: c.name, ok: true, detail: 'ok', env: false, durationMs: 1 })),
  passed: true,
  envBlocked: false,
});

/** Среда зелёная, ничего наружу не ходит. */
function greenDeps(over: Partial<PreflightDeps> = {}): Partial<PreflightDeps> {
  return {
    probe: greenProbe,
    contextProblem: async () => null,
    spawnScript: async () => ({ exitCode: 0, stdout: '', stderr: '', timedOut: false }),
    spawnTest: async () => ({ exitCode: 0, stdout: 'ok 1 - t', stderr: '', timedOut: false }),
    ...over,
  };
}

describe('preflightExitCode', () => {
  const base: PreflightReport = { model: 'm', task: 'oversize', checks: [], passed: true, envBlocked: false };
  it('зелёный → 0; модель красная → 1; среда красная → 2', () => {
    strictEqual(preflightExitCode(base), 0);
    strictEqual(
      preflightExitCode({ ...base, passed: false, checks: [{ name: 'x', ok: false, env: false, detail: '', durationMs: 0 }] }),
      1,
    );
    strictEqual(
      preflightExitCode({
        ...base,
        passed: false,
        envBlocked: true,
        checks: [{ name: 'x', ok: false, env: true, detail: '', durationMs: 0 }],
      }),
      2,
    );
  });
});

describe('formatPreflight', () => {
  it('называет вердикт: среду — отдельно от модели', () => {
    const envRed: PreflightReport = {
      model: 'm',
      task: 'oversize',
      checks: [{ name: 'снимок', ok: false, env: true, detail: 'нет snapshot.json', durationMs: 1 }],
      passed: false,
      envBlocked: true,
    };
    ok(formatPreflight(envRed).includes('по среде'), formatPreflight(envRed));
    const modelRed: PreflightReport = { ...envRed, envBlocked: false, checks: [{ ...envRed.checks[0]!, env: false }] };
    ok(formatPreflight(modelRed).includes('по модели'), formatPreflight(modelRed));
  });
});

describe('runPreflight', () => {
  it('зелёная среда + зелёная проба — passed, все группы проверок присутствуют', async () => {
    const report = await runPreflight(opts(['--model', MODEL, '--stage', 'chunk']), greenDeps());
    strictEqual(report.passed, true, JSON.stringify(report.checks.filter((c) => !c.ok)));
    const names = report.checks.map((c) => c.name).join('\n');
    ok(names.includes('задача'), names);
    ok(names.includes('конфиг'), names);
    ok(names.includes('фикстура'), names);
    ok(names.includes('окно контекста'), names);
    ok(names.includes('модель: честность путей'), names);
  });

  it('банк ответов и лимит ходов проверяются; лимит ниже штатного — предупреждение, не красный', async () => {
    const report = await runPreflight(opts(['--model', MODEL, '--stage', 'chunk', '--max-turns', '5']), greenDeps());
    const bank = report.checks.find((c) => c.name === 'задача: банк ответов человека');
    strictEqual(bank?.ok, true, bank?.detail);
    const turns = report.checks.find((c) => c.name === 'стенд: лимит ходов');
    strictEqual(turns?.ok, true, turns?.detail);
    ok(turns?.detail.includes('НИЖЕ'), turns?.detail);
    strictEqual(
      report.checks.some((c) => c.name === 'модель: промпт plan против окна'),
      false,
      'plan не измеряется режимом --stage chunk — оценивать его промпт нечего',
    );
  });

  it('красная фикстура — envBlocked, модельные проверки НЕ гоняются', async () => {
    let probeCalled = false;
    const report = await runPreflight(
      opts(['--model', MODEL, '--stage', 'chunk']),
      greenDeps({
        spawnTest: async () => ({ exitCode: 1, stdout: 'not ok 1 - t', stderr: '', timedOut: false }),
        probe: async (a) => {
          probeCalled = true;
          return greenProbe(a);
        },
      }),
    );
    strictEqual(report.passed, false);
    strictEqual(report.envBlocked, true);
    strictEqual(probeCalled, false, 'дергать модель при красной среде бессмысленно');
    strictEqual(preflightExitCode(report), 2);
  });

  it('намеренно красная фикстура (broken-test) инвертирует проверку: красная — ок, зелёная — среда красная', async () => {
    const red = await runPreflight(
      opts(['--model', MODEL, '--task', 'broken-test', '--stage', 'chunk']),
      greenDeps({ spawnTest: async () => ({ exitCode: 1, stdout: 'not ok', stderr: '', timedOut: false }) }),
    );
    const fixtureRed = red.checks.find((c) => c.name === 'фикстура: тесты');
    strictEqual(fixtureRed?.ok, true, fixtureRed?.detail);

    const green = await runPreflight(
      opts(['--model', MODEL, '--task', 'broken-test', '--stage', 'chunk']),
      greenDeps({ spawnTest: async () => ({ exitCode: 0, stdout: 'ok 1 - t', stderr: '', timedOut: false }) }),
    );
    const fixtureGreen = green.checks.find((c) => c.name === 'фикстура: тесты');
    strictEqual(fixtureGreen?.ok, false);
    strictEqual(green.envBlocked, true);
  });

  it('отсутствующий снимок — envBlocked с именем снимка', async () => {
    const report = await runPreflight(
      opts(['--model', MODEL, '--stage', 'chunk', '--from-snapshot', 'net-takogo-snimka']),
      greenDeps(),
    );
    strictEqual(report.envBlocked, true);
    const snap = report.checks.find((c) => c.name === 'снимок');
    ok(snap !== undefined && !snap.ok && snap.detail.includes('net-takogo-snimka'), JSON.stringify(snap));
  });

  it('расхождение окна — envBlocked до пробы модели', async () => {
    const report = await runPreflight(
      opts(['--model', MODEL, '--stage', 'chunk']),
      greenDeps({ contextProblem: async () => 'тег даёт окно 4096, конфиг ждёт 16384' }),
    );
    strictEqual(report.envBlocked, true);
    ok(report.checks.some((c) => c.name === 'модель: окно контекста' && !c.ok));
    strictEqual(report.checks.some((c) => c.name.startsWith('модель: честность')), false, 'проба не должна была гоняться');
  });

  it('красная модельная проба при зелёной среде — код 1, не 2', async () => {
    const report = await runPreflight(
      opts(['--model', MODEL, '--stage', 'chunk']),
      greenDeps({
        probe: async ({ cases }) => ({
          model: 'm',
          cases: (cases ?? []).map((c) => ({ name: c.name, ok: false, detail: 'вызова нет', env: false, durationMs: 1 })),
          passed: false,
          envBlocked: false,
        }),
      }),
    );
    strictEqual(report.passed, false);
    strictEqual(report.envBlocked, false);
    strictEqual(preflightExitCode(report), 1);
  });

  it('транспортная ошибка в пробе (env-кейс) — код 2: среда, не модель', async () => {
    const report = await runPreflight(
      opts(['--model', MODEL, '--stage', 'chunk']),
      greenDeps({
        probe: async ({ cases }) => ({
          model: 'm',
          cases: (cases ?? []).map((c) => ({ name: c.name, ok: false, detail: 'ECONNREFUSED', env: true, durationMs: 1 })),
          passed: false,
          envBlocked: true,
        }),
      }),
    );
    strictEqual(preflightExitCode(report), 2);
  });

  it('неизвестная модель — средовая проверка конфига красная', async () => {
    const report = await runPreflight(opts(['--model', 'ollama:takoy-net', '--stage', 'chunk']), greenDeps());
    strictEqual(report.envBlocked, true);
    ok(report.checks.some((c) => !c.ok), JSON.stringify(report.checks));
  });
});

describe('runPreflight: мигающая фикстура', () => {
  it('flaky-by-design не проверяет цвет набора: ни зелёный, ни красный прогон не дают отказ среды', async () => {
    let spawned = 0;
    for (const exitCode of [0, 1]) {
      const report = await runPreflight(
        opts(['--model', MODEL, '--task', 'flaky-by-design', '--stage', 'chunk']),
        greenDeps({
          spawnTest: async () => {
            spawned += 1;
            return { exitCode, stdout: '', stderr: '', timedOut: false };
          },
        }),
      );
      const fixture = report.checks.find((c) => c.name === 'фикстура: тесты');
      strictEqual(fixture?.ok, true, fixture?.detail);
      ok(fixture?.detail.includes('мигает'), fixture?.detail);
      strictEqual(report.envBlocked, false, JSON.stringify(report.checks.filter((c) => !c.ok)));
    }
    strictEqual(spawned, 0, 'мигающий набор гонять незачем — цвет одного прогона ничего не говорит');
  });
});

describe('runPreflight: снимок', () => {
  const dirs: string[] = [];
  after(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });
  function snapshots(meta: Record<string, unknown>): string {
    const dir = mkdtempSync(join(tmpdir(), 'sdlc-bench-preflight-snap-'));
    dirs.push(dir);
    mkdirSync(join(dir, 'snap'), { recursive: true });
    writeFileSync(join(dir, 'snap', 'snapshot.json'), JSON.stringify(meta), 'utf8');
    return dir;
  }
  const META = { slug: 's', branch: 'sdlc/x', stoppedAfterStage: 'plan', createdAt: '2026-09-14T00:00:00.000Z', task: 'oversize' };

  it('--all со снимка после plan — законно: первый измеряемый считается после точки снимка', async () => {
    const report = await runPreflight(
      opts(['--model', MODEL, '--all', '--from-snapshot', 'snap']),
      greenDeps({ snapshotsDir: snapshots(META) }),
    );
    const snap = report.checks.find((c) => c.name === 'снимок');
    strictEqual(snap?.ok, true, snap?.detail);
    ok(snap?.detail.includes('«chunk»'), snap?.detail);
  });

  it('измеряемый этап уже пройден снимком — «нечего мерить»', async () => {
    const report = await runPreflight(
      opts(['--model', MODEL, '--stage', 'explore', '--from-snapshot', 'snap']),
      greenDeps({ snapshotsDir: snapshots(META) }),
    );
    const snap = report.checks.find((c) => c.name === 'снимок');
    strictEqual(snap?.ok, false);
    ok(snap?.detail.includes('нечего мерить'), snap?.detail);
    strictEqual(report.envBlocked, true);
  });

  it('снимок без поля task — та же подсказка, что у восстановления, а не «задача undefined»', async () => {
    const { task: _task, ...noTask } = META;
    const report = await runPreflight(
      opts(['--model', MODEL, '--stage', 'chunk', '--from-snapshot', 'snap']),
      greenDeps({ snapshotsDir: snapshots(noTask) }),
    );
    const snap = report.checks.find((c) => c.name === 'снимок');
    strictEqual(snap?.ok, false);
    ok(snap?.detail.includes('"task"') && !snap.detail.includes('undefined'), snap?.detail);
  });
});

describe('runPreflight: лимит ходов против штатного', () => {
  const withLimits = (maxIterationsPerStage: number, maxIterationsByStage: Record<string, number>) => () => {
    const c = loadConfig();
    return { ...c, runner: { ...c.runner, limits: { ...c.runner.limits, maxIterationsPerStage, maxIterationsByStage } } };
  };

  it('без --max-turns сверять нечего: лимит штатный из конфига, какой бы он ни был', async () => {
    const report = await runPreflight(
      opts(['--model', MODEL, '--stage', 'chunk']),
      greenDeps({ loadConfig: withLimits(100, { verify: 120 }) }),
    );
    const turns = report.checks.find((c) => c.name === 'стенд: лимит ходов');
    ok(turns !== undefined && !turns.detail.includes('⚠'), turns?.detail);
    ok(turns?.detail.includes('100'), turns?.detail);
  });

  it('явный --max-turns выше общего, но ниже поэтапного потолка — предупреждение с этапом', async () => {
    const report = await runPreflight(
      opts(['--model', MODEL, '--stage', 'chunk', '--max-turns', '50']),
      greenDeps({ loadConfig: withLimits(40, { verify: 60 }) }),
    );
    const turns = report.checks.find((c) => c.name === 'стенд: лимит ходов');
    strictEqual(turns?.ok, true);
    ok(turns?.detail.includes('⚠') && turns.detail.includes('verify 60'), turns?.detail);
  });
});

describe('spawnNode', () => {
  it('гасит NODE_TEST_CONTEXT: дочерний узел не считает себя частью идущего прогона', async () => {
    // Этот файл сам идёт под `node --test` — переменная у процесса есть.
    const r = await spawnNode({ args: ['-e', 'process.stdout.write(process.env.NODE_TEST_CONTEXT ?? "нет")'], timeoutMs: 30_000 });
    strictEqual(r.exitCode, 0, r.stderr);
    strictEqual(r.stdout, 'нет');
  });
});
