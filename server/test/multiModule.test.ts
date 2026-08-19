/**
 * Гейты по всем затронутым модулям, а не по первому.
 *
 * Это закрытие ложного зелёного по построению: план трогает `server/` и `web/`, гейт
 * собирал `server/`, а отчёт этапа 6 писал «Сборка ✅». Поэтому главные проверки здесь —
 * не «нашлись оба модуля», а «зелёный не выдаётся, пока не проверены все».
 */

import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { match, ok, strictEqual } from 'node:assert/strict';
import { describe, it } from 'node:test';

import { BUILTIN } from '../src/gates/builtin/index.ts';
import type { GateContext } from '../src/gates/builtin/index.ts';
import { moduleDirsFromPlan } from '../src/gates/builtin/logic.ts';
import type { ModuleProfile } from '../src/config/schema.ts';

/** Моно-репо из двух модулей: оба объявлены явно, командой управляет тест. */
function monorepo(): string {
  const root = mkdtempSync(join(tmpdir(), 'sdlc-multi-'));
  for (const dir of ['api', 'web']) {
    mkdirSync(join(root, dir), { recursive: true });
  }
  return root;
}

function ctx(root: string, planFiles: string[], modules: ModuleProfile[]): GateContext {
  return { projectRoot: root, planFiles, baseline: null, timeoutMs: 10_000, modules };
}

// Встроенные команды оболочки: пол безопасности их пропускает, а исход предсказуем.
const ok0 = 'true';
const fail1 = 'false';

describe('поиск всех модулей плана', () => {
  const isModule = (d: string): boolean => d === 'api' || d === 'web';

  it('план из двух модулей даёт оба, в порядке первого появления', () => {
    const dirs = moduleDirsFromPlan(['web/src/a.ts', 'api/main.go', 'web/src/b.ts'], isModule);
    strictEqual(dirs.join(','), 'web,api');
  });

  it('повторы одного модуля не дублируются', () => {
    strictEqual(moduleDirsFromPlan(['api/a', 'api/b', 'api/c'], isModule).length, 1);
  });

  it('корень берётся только когда не нашлось ни одного модуля', () => {
    strictEqual(moduleDirsFromPlan(['docs/x.md'], (d) => d === '.').join(','), '.');
    // Иначе корень добавлялся бы к каждому моно-репо вторым «модулем» и собирал бы всё дважды.
    strictEqual(
      moduleDirsFromPlan(['api/a'], (d) => d === 'api' || d === '.').join(','),
      'api',
    );
  });

  it('модулей нет вовсе — пустой список, а не корень', () => {
    strictEqual(moduleDirsFromPlan(['docs/x.md'], () => false).length, 0);
  });
});

describe('агрегация исходов по модулям', () => {
  it('падение второго модуля роняет гейт целиком', async () => {
    const root = monorepo();
    const build = BUILTIN.get('сборка');
    ok(build !== undefined);

    const outcome = await build(
      ctx(root, ['api/a.go', 'web/b.ts'], [
        { dir: 'api', build: ok0 },
        { dir: 'web', build: fail1 },
      ]),
    );
    strictEqual(outcome.status, '❌');
    // Имя модуля обязано быть в выводе: «Сборка ❌» без него в моно-репо не диагностична.
    match(outcome.lastLine, /web/);
    match(outcome.lastLine, /модулей проверено: 2/);
  });

  it('зелёный — только когда прошли ВСЕ модули', async () => {
    const root = monorepo();
    const build = BUILTIN.get('сборка');
    ok(build !== undefined);

    const outcome = await build(
      ctx(root, ['api/a.go', 'web/b.ts'], [
        { dir: 'api', build: ok0 },
        { dir: 'web', build: ok0 },
      ]),
    );
    strictEqual(outcome.status, '✅');
  });

  it('пропуск одного модуля не даёт зелёного всему гейту', async () => {
    const root = monorepo();
    const test = BUILTIN.get('тесты');
    ok(test !== undefined);

    const outcome = await test(
      ctx(root, ['api/a.go', 'web/b.ts'], [
        { dir: 'api', build: ok0, test: ok0 },
        // Раннера нет намеренно — это `⏭`, и он строже зелёного.
        { dir: 'web', build: ok0, test: null },
      ]),
    );
    strictEqual(outcome.status, '⏭');
    match(outcome.lastLine, /web/);
  });

  it('единственный модуль отдаётся как есть, без обёртки перечня', async () => {
    const root = monorepo();
    const build = BUILTIN.get('сборка');
    ok(build !== undefined);

    const outcome = await build(ctx(root, ['api/a.go'], [{ dir: 'api', build: ok0 }]));
    strictEqual(outcome.status, '✅');
    strictEqual(outcome.command, ok0);
  });

  it('проход по модулям последовательный по умолчанию', async () => {
    const root = monorepo();
    const build = BUILTIN.get('сборка');
    ok(build !== undefined);
    // Параллельность включается лимитом и должна оправдываться замером: по умолчанию
    // модули делят диск, память и порты, и одновременный `npm ci` им не помогает.
    const c = ctx(root, ['api/a.go', 'web/b.ts'], [
      { dir: 'api', build: ok0 },
      { dir: 'web', build: ok0 },
    ]);
    strictEqual(c.moduleParallel, undefined);
    const outcome = await build(c);
    strictEqual(outcome.status, '✅');
  });
});
