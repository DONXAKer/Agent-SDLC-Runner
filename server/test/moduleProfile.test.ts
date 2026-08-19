/**
 * Описание модулей проекта: приоритет источников и отказ загрузки на неверном описании.
 *
 * Проверяется то, ради чего поле заводилось: человек, назвавший команду своего модуля,
 * знает про него больше, чем детект, — но опечатка в этом описании обязана останавливать
 * виток, а не превращаться в «детект почему-то не сработал».
 */

import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { match, ok, strictEqual, throws } from 'node:assert/strict';
import { describe, it } from 'node:test';

import { loadConfig } from '../src/config/load.ts';
import { BUILTIN } from '../src/gates/builtin/index.ts';
import type { GateContext } from '../src/gates/builtin/index.ts';
import type { ModuleProfile } from '../src/config/schema.ts';

/** Целевой проект: моно-репо с двумя модулями, ни один из которых не npm. */
function project(): string {
  const root = mkdtempSync(join(tmpdir(), 'sdlc-mod-'));
  mkdirSync(join(root, 'api'), { recursive: true });
  mkdirSync(join(root, 'web'), { recursive: true });
  writeFileSync(join(root, 'web', 'package.json'), '{"scripts":{"build":"vite build"}}');
  // Без каталога зависимостей гейт «Сборка» честно уходит в проверку синтаксиса и команду
  // не запускает — здесь проверяется выбор команды, поэтому зависимости «установлены».
  mkdirSync(join(root, 'web', 'node_modules'), { recursive: true });
  return root;
}

function ctx(root: string, planFiles: string[], modules?: ModuleProfile[]): GateContext {
  return {
    projectRoot: root,
    planFiles,
    baseline: null,
    timeoutMs: 5_000,
    ...(modules === undefined ? {} : { modules }),
  };
}

/** Конфиг на диске: минимальный набор файлов, который читает `loadConfig`. */
function configDir(modules: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'sdlc-cfg-'));
  const root = project();
  writeFileSync(join(dir, 'runner.json'), JSON.stringify({ operator: 'тест', limits: {} }));
  writeFileSync(join(dir, 'models.json'), JSON.stringify({ providers: {}, models: [] }));
  mkdirSync(join(dir, 'projects'));
  writeFileSync(
    join(dir, 'projects', 'p.json'),
    JSON.stringify({
      name: 'p',
      projectRoot: root,
      activeProfile: 'x',
      maxBudgetUsd: 1,
      profiles: {},
      modules,
    }),
  );
  return dir;
}

describe('описание модулей проекта', () => {
  it('команда из описания перекрывает автодетект', async () => {
    const root = project();
    const build = BUILTIN.get('сборка');
    ok(build !== undefined);

    // Без описания на `web/` сработал бы детект и дал `npm run build`.
    const declared = await build(
      ctx(root, ['web/src/a.ts'], [{ dir: 'web', build: 'pnpm build' }]),
    );
    strictEqual(declared.command, 'pnpm build');
  });

  it('модуль без манифеста становится модулем, если он объявлен', async () => {
    const root = project();
    const build = BUILTIN.get('сборка');
    ok(build !== undefined);

    // В `api/` нет ни одного знакомого детекту манифеста.
    const outcome = await build(ctx(root, ['api/main.rb'], [{ dir: 'api', build: 'rake build' }]));
    strictEqual(outcome.command, 'rake build');
  });

  it('путь модуля сравнивается в нормализованной форме', async () => {
    const root = project();
    const build = BUILTIN.get('сборка');
    ok(build !== undefined);
    const outcome = await build(ctx(root, ['web/src/a.ts'], [{ dir: './web/', build: 'x-build' }]));
    strictEqual(outcome.command, 'x-build');
  });

  it('`test: null` в описании означает «раннера нет намеренно» и не перекрывается детектом', async () => {
    const root = project();
    writeFileSync(join(root, 'web', 'package.json'), '{"scripts":{"build":"v","test":"vitest"}}');
    const test = BUILTIN.get('тесты');
    ok(test !== undefined);

    const outcome = await test(
      ctx(root, ['web/src/a.ts'], [{ dir: 'web', build: 'v', test: null }]),
    );
    strictEqual(outcome.status, '⏭');
    match(outcome.lastLine, /тест-раннер не обнаружен/);
  });

  it('без описания поведение прежнее — работает автодетект', async () => {
    const root = project();
    const build = BUILTIN.get('сборка');
    ok(build !== undefined);
    const outcome = await build(ctx(root, ['web/src/a.ts']));
    strictEqual(outcome.command, 'npm run build');
  });
});

describe('валидация описания модулей при загрузке', () => {
  it('пустое поле modules не ломает загрузку', () => {
    const cfg = loadConfig(configDir(undefined));
    strictEqual(cfg.projects.get('p')?.modules, undefined);
  });

  it('корректное описание читается как есть', () => {
    const cfg = loadConfig(configDir([{ dir: 'web', ecosystem: 'node' }]));
    strictEqual(cfg.projects.get('p')?.modules?.[0]?.ecosystem, 'node');
  });

  it('несуществующий каталог модуля — ошибка загрузки, а не молчание', () => {
    throws(() => loadConfig(configDir([{ dir: 'нет-такого', build: 'x' }])), /не существует/);
  });

  it('неизвестная экосистема названа вместе со списком известных', () => {
    throws(() => loadConfig(configDir([{ dir: 'web', ecosystem: 'котлин' }])), /неизвестная экосистема/);
  });

  it('описание без ecosystem и без build отвергается: оно ничего не добавляет', () => {
    throws(() => loadConfig(configDir([{ dir: 'web' }])), /ecosystem или build/);
  });

  it('дважды описанный модуль — ошибка: какой из двух применять, неизвестно', () => {
    throws(
      () => loadConfig(configDir([{ dir: 'web', build: 'a' }, { dir: './web', build: 'b' }])),
      /описан дважды/,
    );
  });

  it('modules не списком отвергается', () => {
    throws(() => loadConfig(configDir({ dir: 'web' })), /должно быть списком/);
  });
});
