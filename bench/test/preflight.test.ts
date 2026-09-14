/**
 * Преполётный тест (`src/preflight.ts`) — герметично: сеть и дочерние процессы
 * подменяются через `PreflightDeps`, файловые проверки идут по настоящему bench/.
 */

import { ok, strictEqual } from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { ProbeReport } from '../../server/src/probe.ts';
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
