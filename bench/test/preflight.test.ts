/**
 * Преполётный тест (`src/preflight.ts`) — герметично: сеть и дочерние процессы
 * подменяются через `PreflightDeps`, файловые проверки идут по настоящему bench/.
 */

import { ok, deepStrictEqual, strictEqual } from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { loadConfig } from '../../server/src/config/load.ts';
import type { ProbeReport } from '../../server/src/probe.ts';
import { ProviderEnvError, ProviderHttpError } from '../../server/src/provider/ChatProvider.ts';
import { spawnNode } from '../src/nodeTest.ts';
import { parseArgs } from '../src/options.ts';
import type { BenchOptions } from '../src/options.ts';
import { formatPreflight, preflightExitCode, runPreflight } from '../src/preflight.ts';
import type { PreflightDeps, PreflightReport } from '../src/preflight.ts';

const MODEL = 'ollama:qwen3:8b-ctx16k'; // существующая запись конфига (qwen3.5:4b-ctx16k удалён чисткой 2026-09-22)

function opts(argv: readonly string[]): BenchOptions {
  return parseArgs(argv);
}

const greenProbe: PreflightDeps['probe'] = async ({ cases }) => ({
  model: 'm',
  cases: (cases ?? []).map((c) => ({ name: c.name, ok: true, detail: 'ok', env: false, timedOut: false, durationMs: 1 })),
  passed: true,
  envBlocked: false,
});

/** Среда зелёная, ничего наружу не ходит. */
function greenDeps(over: Partial<PreflightDeps> = {}): Partial<PreflightDeps> {
  return {
    probe: greenProbe,
    // Прогрев и перезагрузка — внешние вызовы (chat, lms); в герметичном тесте — заглушки.
    warmup: async () => {},
    reloadEngine: async () => ({ kind: 'reloaded', detail: 'заглушка' }),
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
      greenDeps({ contextProblem: async () => ({ message: 'тег даёт окно 4096, конфиг ждёт 16384', reloadable: false }) }),
    );
    strictEqual(report.envBlocked, true);
    ok(report.checks.some((c) => c.name === 'модель: окно контекста' && !c.ok));
    strictEqual(report.checks.some((c) => c.name.startsWith('модель: честность')), false, 'проба не должна была гоняться');
  });

  it('расхождение окна помечено reloadable, но БЕЗ --engine-reload — код 2, перезагрузка не вызывается', async () => {
    let reloadCalled = false;
    const report = await runPreflight(
      opts(['--model', MODEL, '--stage', 'chunk']),
      greenDeps({
        contextProblem: async () => ({ message: 'модель не загружена', reloadable: true }),
        reloadEngine: async () => {
          reloadCalled = true;
          return { kind: 'reloaded' as const, detail: 'x' };
        },
      }),
    );
    strictEqual(reloadCalled, false, 'GPU общий — без явного флага перезагрузки нет');
    strictEqual(preflightExitCode(report), 2);
    ok(report.checks.some((c) => c.name === 'модель: окно контекста' && !c.ok));
  });

  it('--engine-reload чинит reloadable окно ДО прогрева: одна перезагрузка, повтор проверки зелёный (серия local6, 2026-09-24)', async () => {
    let reloads = 0;
    let contextCalls = 0;
    const report = await runPreflight(
      opts(['--model', MODEL, '--stage', 'chunk', '--engine-reload']),
      greenDeps({
        contextProblem: async () => {
          contextCalls += 1;
          return contextCalls === 1 ? { message: 'модель не загружена (state: not-loaded)', reloadable: true } : null;
        },
        reloadEngine: async () => {
          reloads += 1;
          return { kind: 'reloaded' as const, detail: 'lms load m -c 32768 --parallel 1 зелёный' };
        },
      }),
    );
    strictEqual(reloads, 1);
    strictEqual(contextCalls, 2, 'первая проверка красная, вторая — после перезагрузки');
    strictEqual(report.passed, true, JSON.stringify(report.checks.filter((c) => !c.ok)));
    const c = report.checks.find((x) => x.name.startsWith('модель: окно контекста'));
    ok(c?.name.includes('после перезагрузки'), JSON.stringify(c));
  });

  it('--engine-reload на reloadable окне, но перезагрузка не удалась — старые красные проверки НЕ теряются', async () => {
    let contextCalls = 0;
    const report = await runPreflight(
      opts(['--model', MODEL, '--stage', 'chunk', '--engine-reload']),
      greenDeps({
        contextProblem: async () => {
          contextCalls += 1;
          return { message: 'модель не загружена (state: not-loaded)', reloadable: true };
        },
        reloadEngine: async () => ({ kind: 'failed' as const, detail: 'lms load снят по таймауту' }),
      }),
    );
    strictEqual(contextCalls, 1, 'перезагрузка не удалась — второй проверки окна нет');
    strictEqual(preflightExitCode(report), 2);
    ok(report.checks.some((c) => c.name === 'модель: окно контекста' && !c.ok), JSON.stringify(report.checks));
    ok(report.checks.some((c) => !c.ok && c.detail.includes('lms load снят по таймауту')), JSON.stringify(report.checks));
  });

  it('красная модельная проба при зелёной среде — код 1, не 2', async () => {
    const report = await runPreflight(
      opts(['--model', MODEL, '--stage', 'chunk']),
      greenDeps({
        probe: async ({ cases }) => ({
          model: 'm',
          cases: (cases ?? []).map((c) => ({ name: c.name, ok: false, detail: 'вызова нет', env: false, timedOut: false, durationMs: 1 })),
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
          cases: (cases ?? []).map((c) => ({ name: c.name, ok: false, detail: 'ECONNREFUSED', env: true, timedOut: false, durationMs: 1 })),
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

describe('runPreflight: вторая попытка модельных кейсов', () => {
  const FLAKY = 'правка поля без перезаписи файла';

  /** Проба со сценарием для одного кейса: полный проход — красный, повтор — по флагу. */
  const scriptedProbe =
    (retryOk: boolean, env = false): PreflightDeps['probe'] =>
    async ({ cases }) => {
      const list = cases ?? [];
      const single = list.length === 1;
      return {
        model: 'm',
        cases: list.map((c) => ({
          name: c.name,
          ok: c.name !== FLAKY || (single && retryOk),
          env: c.name === FLAKY && env,
          timedOut: false,
          detail: c.name === FLAKY ? (single ? 'повтор' : 'вызова нет') : 'ok',
          durationMs: 1,
        })),
        passed: true,
        envBlocked: false,
      };
    };

  it('одиночный ❌ шумного кейса: повтор зелёный — преполёт зелёный с пометкой «со 2-й попытки»', async () => {
    let calls = 0;
    const probe: PreflightDeps['probe'] = async (a) => {
      calls += 1;
      return scriptedProbe(true)(a);
    };
    const report = await runPreflight(opts(['--model', MODEL, '--stage', 'chunk']), greenDeps({ probe }));
    strictEqual(report.passed, true, JSON.stringify(report.checks.filter((c) => !c.ok)));
    strictEqual(report.envBlocked, false);
    const c = report.checks.find((x) => x.name === `модель: ${FLAKY}`);
    strictEqual(c?.ok, true, c?.detail);
    ok(c?.detail.includes('со 2-й попытки'), c?.detail);
    strictEqual(calls, 2, 'полный проход + один перезапуск упавшего кейса');
  });

  it('обе попытки красные — преполёт красный по модели (код 1), в деталях «2/2 попыток»', async () => {
    let calls = 0;
    const probe: PreflightDeps['probe'] = async (a) => {
      calls += 1;
      return scriptedProbe(false)(a);
    };
    const report = await runPreflight(opts(['--model', MODEL, '--stage', 'chunk']), greenDeps({ probe }));
    strictEqual(report.passed, false);
    strictEqual(report.envBlocked, false);
    strictEqual(preflightExitCode(report), 1);
    const c = report.checks.find((x) => x.name === `модель: ${FLAKY}`);
    strictEqual(c?.ok, false);
    ok(c?.detail.includes('2/2 попыток'), c?.detail);
    strictEqual(calls, 2);
  });

  it('средовой сбой (⛔) НЕ перезапускается: один проход, код 2', async () => {
    let calls = 0;
    const probe: PreflightDeps['probe'] = async (a) => {
      calls += 1;
      return scriptedProbe(false, true)(a);
    };
    const report = await runPreflight(opts(['--model', MODEL, '--stage', 'chunk']), greenDeps({ probe }));
    strictEqual(report.passed, false);
    strictEqual(report.envBlocked, true);
    strictEqual(preflightExitCode(report), 2);
    strictEqual(calls, 1, 'ретрай средового сбоя дорог (таймаут 120 с) и не про модель');
  });

  it('модельный провал + повтор, упавший средой — кейс не измерен: средовый красный (код 2)', async () => {
    const probe: PreflightDeps['probe'] = async ({ cases }) => {
      const list = cases ?? [];
      const single = list.length === 1;
      return {
        model: 'm',
        cases: list.map((c) => ({
          name: c.name,
          ok: c.name !== FLAKY,
          env: c.name === FLAKY && single,
          timedOut: false,
          detail: single ? 'ECONNREFUSED' : 'вызова нет',
          durationMs: 1,
        })),
        passed: false,
        envBlocked: single,
      };
    };
    const report = await runPreflight(opts(['--model', MODEL, '--stage', 'chunk']), greenDeps({ probe }));
    strictEqual(report.envBlocked, true, JSON.stringify(report.checks.filter((c) => !c.ok)));
    strictEqual(preflightExitCode(report), 2);
    const c = report.checks.find((x) => x.name === `модель: ${FLAKY}`);
    strictEqual(c?.env, true, c?.detail);
    ok(c?.detail.includes('не измерен'), c?.detail);
  });

  it('кейс с timedOut — код 1 (не 2), НЕ перезапускается (серия local6, 2026-09-24: apriel-1.6-15b)', async () => {
    let calls = 0;
    const probe: PreflightDeps['probe'] = async ({ cases }) => {
      calls += 1;
      const list = cases ?? [];
      return {
        model: 'm',
        cases: list.map((c) => ({
          name: c.name,
          ok: c.name !== FLAKY,
          env: false,
          timedOut: c.name === FLAKY,
          detail: c.name === FLAKY ? 'кейс не уложился в потолок 120000 мс' : 'ok',
          durationMs: 1,
        })),
        passed: false,
        envBlocked: false,
      };
    };
    const report = await runPreflight(opts(['--model', MODEL, '--stage', 'chunk']), greenDeps({ probe }));
    strictEqual(report.envBlocked, false, JSON.stringify(report.checks.filter((c) => !c.ok)));
    strictEqual(preflightExitCode(report), 1);
    strictEqual(calls, 1, 'таймаут кейса не перезапускается — повтор удвоил бы тот же потолок');
    const c = report.checks.find((x) => x.name === `модель: ${FLAKY}`);
    strictEqual(c?.ok, false);
    strictEqual(c?.env, false);
  });

  it('--probe-timeout передаётся пробе как caseTimeoutMs', async () => {
    let seenTimeout: number | undefined;
    const probe: PreflightDeps['probe'] = async (a) => {
      seenTimeout = a.caseTimeoutMs;
      return greenProbe(a);
    };
    await runPreflight(opts(['--model', MODEL, '--stage', 'chunk', '--probe-timeout', '6']), greenDeps({ probe }));
    strictEqual(seenTimeout, 6 * 60_000);
  });
});

describe('runPreflight: прогрев движка и автоперезагрузка', () => {
  const WARMUP_CHECK = 'модель: прогрев движка';

  it('прогрев идёт ДО проб и вердикт не меняет: зелёный прогрев — просто строка с длительностью', async () => {
    const order: string[] = [];
    const report = await runPreflight(
      opts(['--model', MODEL, '--stage', 'chunk']),
      greenDeps({
        warmup: async () => {
          order.push('warmup');
        },
        probe: async (a) => {
          order.push('probe');
          return greenProbe(a);
        },
      }),
    );
    strictEqual(report.passed, true, JSON.stringify(report.checks.filter((c) => !c.ok)));
    const c = report.checks.find((x) => x.name === WARMUP_CHECK);
    strictEqual(c?.ok, true, c?.detail);
    deepStrictEqual(order, ['warmup', 'probe'], 'холодный старт обязан уйти в прогрев, а не в первую пробу');
  });

  it('прогрев упал средой, флаг выключен — код 2, проба не гонялась, перезагрузки нет, есть подсказка', async () => {
    let probeCalled = false;
    let reloadCalled = false;
    const report = await runPreflight(
      opts(['--model', MODEL, '--stage', 'chunk']),
      greenDeps({
        warmup: async () => {
          throw new ProviderEnvError('HTTP 400 terminated');
        },
        probe: async (a) => {
          probeCalled = true;
          return greenProbe(a);
        },
        reloadEngine: async () => {
          reloadCalled = true;
          return { kind: 'reloaded' as const, detail: 'x' };
        },
      }),
    );
    strictEqual(report.envBlocked, true);
    strictEqual(preflightExitCode(report), 2);
    strictEqual(probeCalled, false, 'гонять семь кейсов по лёгшему движку бессмысленно');
    strictEqual(reloadCalled, false, 'GPU общий — без явного флага перезагрузки нет');
    const c = report.checks.find((x) => x.name === WARMUP_CHECK);
    ok(c?.detail.includes('--engine-reload'), c?.detail);
  });

  it('флаг включён: после сбоя движка — одна перезагрузка и один повтор; повтор зелёный — преполёт зелёный', async () => {
    let warmups = 0;
    let reloads = 0;
    const report = await runPreflight(
      opts(['--model', MODEL, '--stage', 'chunk', '--engine-reload']),
      greenDeps({
        warmup: async () => {
          warmups += 1;
          if (warmups === 1) throw new Error('fetch failed');
        },
        reloadEngine: async () => {
          reloads += 1;
          return { kind: 'reloaded' as const, detail: 'lms load m зелёный' };
        },
      }),
    );
    strictEqual(report.passed, true, JSON.stringify(report.checks.filter((c) => !c.ok)));
    strictEqual(warmups, 2, 'первый прогрев + ровно один повтор после перезагрузки');
    strictEqual(reloads, 1);
    const c = report.checks.find((x) => x.name === WARMUP_CHECK);
    ok(c?.detail.includes('после перезагрузки'), c?.detail);
  });

  it('флаг включён, повтор снова упал — код 2, третьей попытки нет', async () => {
    let warmups = 0;
    const report = await runPreflight(
      opts(['--model', MODEL, '--stage', 'chunk', '--engine-reload']),
      greenDeps({
        warmup: async () => {
          warmups += 1;
          throw new Error('fetch failed');
        },
        reloadEngine: async () => ({ kind: 'reloaded' as const, detail: 'ok' }),
      }),
    );
    strictEqual(preflightExitCode(report), 2);
    strictEqual(warmups, 2, 'повтор после перезагрузки ровно один');
  });

  it('перезагрузка не поддержана провайдером — честное сообщение, повтора пробы нет', async () => {
    let warmups = 0;
    const report = await runPreflight(
      opts(['--model', MODEL, '--stage', 'chunk', '--engine-reload']),
      greenDeps({
        warmup: async () => {
          warmups += 1;
          throw new ProviderEnvError('HTTP 400 terminated');
        },
        reloadEngine: async () => ({ kind: 'unsupported' as const, detail: 'автоперезагрузка не поддержана' }),
      }),
    );
    strictEqual(preflightExitCode(report), 2);
    strictEqual(warmups, 1, 'без выполненной перезагрузки повтор бессмыслен');
    const c = report.checks.find((x) => x.name === WARMUP_CHECK);
    ok(c?.detail.includes('не поддержана'), c?.detail);
  });

  it('не-средовой сбой прогрева перезагрузку не вызывает даже с флагом и преполёт не красит — классифицирует проба', async () => {
    let reloads = 0;
    let probeCalled = false;
    const report = await runPreflight(
      opts(['--model', MODEL, '--stage', 'chunk', '--engine-reload']),
      greenDeps({
        warmup: async () => {
          throw new ProviderHttpError('ollama: HTTP 400 от http://x — {"error":"max_tokens слишком мал"}', 400);
        },
        probe: async (a) => {
          probeCalled = true;
          return greenProbe(a);
        },
        reloadEngine: async () => {
          reloads += 1;
          return { kind: 'reloaded' as const, detail: 'x' };
        },
      }),
    );
    strictEqual(reloads, 0, 'перезагрузка — только при сбое движка, не при любой ошибке');
    strictEqual(probeCalled, true, 'ошибку не-движка классифицирует проба тем же запросом');
    strictEqual(preflightExitCode(report), 0, JSON.stringify(report.checks.filter((c) => !c.ok)));
  });

  it('HTTP-ошибка с «fetch failed» в сыром теле — не сбой движка: перезагрузки нет', async () => {
    let reloads = 0;
    await runPreflight(
      opts(['--model', MODEL, '--stage', 'chunk', '--engine-reload']),
      greenDeps({
        warmup: async () => {
          throw new ProviderHttpError('ollama: HTTP 400 от http://x — {"error":{"message":"upstream fetch failed"}}', 400);
        },
        reloadEngine: async () => {
          reloads += 1;
          return { kind: 'reloaded' as const, detail: 'x' };
        },
      }),
    );
    strictEqual(reloads, 0);
  });

  it('после перезагрузки окно контекста перепроверяется: урезанное окно краснит преполёт', async () => {
    let warmups = 0;
    let contextCalls = 0;
    const report = await runPreflight(
      opts(['--model', MODEL, '--stage', 'chunk', '--engine-reload']),
      greenDeps({
        warmup: async () => {
          warmups += 1;
          if (warmups === 1) throw new ProviderEnvError('движок не ответил на прогрев');
        },
        contextProblem: async () => {
          contextCalls += 1;
          return contextCalls === 1 ? null : { message: 'загружено с окном 4096, конфиг ждёт 16384', reloadable: false };
        },
      }),
    );
    strictEqual(preflightExitCode(report), 2);
    ok(
      report.checks.some((c) => !c.ok && c.name.includes('после перезагрузки')),
      JSON.stringify(report.checks.filter((c) => !c.ok)),
    );
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
