/**
 * Потолок ходов ОТДЕЛЬНОГО этапа (`limits.maxIterationsByStage`).
 *
 * Ручка заведена по замеру, а не по вкусу: у рецензента этапа 6 работа линейная, и при 40
 * ходах отчёт остаётся незакрытым, при 60 тот же `ministral-14b` закрывает этап сам
 * (`docs/model-runs.md`, серия r9). На исполнителе этапа 5 та же ручка эффекта не дала
 * вовсе — одно число на все этапы поэтому заведомо неверно хотя бы для одного из них.
 */

import { deepStrictEqual, ok, strictEqual } from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { configDir, loadConfig } from '../src/config/load.ts';
import { withEnv } from './testUtils.ts';

/** Копия закоммиченного каталога конфигов, в которую можно дописать `runner.local.json`. */
function configCopy(): { dir: string; dispose: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'sdlc-cfg-'));
  cpSync(configDir(), dir, { recursive: true });
  return { dir, dispose: () => rmSync(dir, { recursive: true, force: true }) };
}

describe('поэтапный потолок ходов', () => {
  it('умолчание репозитория поднимает только этап 6', () => {
    const limits = loadConfig().runner.limits;
    strictEqual(limits.maxIterationsByStage?.verify, 60);
    strictEqual(limits.maxIterationsByStage?.chunk, undefined);
    strictEqual(limits.maxIterationsPerStage, 40);
  });

  it('runner.local.json правит один этап, не стирая остальные', () => {
    // Главный тест ключа. При обычном слиянии объектов `{ chunk: 30 }` из локального файла
    // затирал бы умолчание `{ verify: 60 }` целиком, этап 6 молча возвращался бы к 40
    // ходам — и это выглядело бы как деградация модели, а не как правка конфига.
    const cfg = configCopy();
    try {
      writeFileSync(
        join(cfg.dir, 'runner.local.json'),
        JSON.stringify({ limits: { maxIterationsByStage: { chunk: 30 } } }),
        'utf8',
      );
      withEnv('SDLC_CONFIG_DIR', cfg.dir, () => {
        const limits = loadConfig().runner.limits;
        deepStrictEqual(limits.maxIterationsByStage, { verify: 60, chunk: 30 });
      });
    } finally {
      cfg.dispose();
    }
  });

  it('локальное значение того же этапа побеждает умолчание', () => {
    const cfg = configCopy();
    try {
      writeFileSync(
        join(cfg.dir, 'runner.local.json'),
        JSON.stringify({ limits: { maxIterationsByStage: { verify: 100 } } }),
        'utf8',
      );
      withEnv('SDLC_CONFIG_DIR', cfg.dir, () => {
        strictEqual(loadConfig().runner.limits.maxIterationsByStage?.verify, 100);
      });
    } finally {
      cfg.dispose();
    }
  });
});

describe('этап 3 не отдаётся режиму заполнения по полям', () => {
  it('formFill не покрывает ask: у режима нет AskHuman, а этап 3 из него и состоит', () => {
    // Живой виток на `ministral-8b`: в clarification-report.md записан вопрос «как
    // обрабатывать сумму измерений ровно 300 см?» и тут же собственный ответ
    // «(пропущено)», ни одного вызова AskHuman, весь этап — один Write за 7 секунд.
    // Ставку, которую задача называет незаписанной, никто не спросил, и все три
    // human-кейса скрытых тестов покраснели по нашей конструкции, а не по модели.
    const src = readFileSync(new URL('../src/run/Run.ts', import.meta.url), 'utf8');
    const m = /const FORM_FILL_STAGES: ReadonlySet<StageId> = new Set\(\[([^\]]*)\]\)/.exec(src);
    ok(m !== null, 'объявление FORM_FILL_STAGES не найдено — тест устарел вместе с кодом');
    const stages = m![1]!;
    strictEqual(/'ask'/.test(stages), false, stages);
    ok(/'intent'/.test(stages) && /'plan'/.test(stages), stages);
  });
});
