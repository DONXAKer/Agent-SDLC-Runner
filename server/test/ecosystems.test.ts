/**
 * Реестр экосистем.
 *
 * Главное, что здесь проверяется, — ПОРЯДОК и полнота: детект сборки решает, какой
 * командой проверяется обязательный гейт «Сборка», и регресс в нём молча меняет смысл
 * зелёного. Список случаев берётся из реестра, а не переписывается сюда руками: таблица
 * тестов, которую надо не забыть дополнить, рано или поздно не дополняется.
 */

import { ok, strictEqual } from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  CODE_EXTENSIONS,
  DISABLE_MARKERS,
  ORDER,
  TEST_DECLARATIONS,
  detectBuildSystem,
  detectEcosystem,
  syntaxCheckerFor,
} from '../src/gates/ecosystems/index.ts';

const set = (...f: string[]): ReadonlySet<string> => new Set(f);

describe('реестр экосистем', () => {
  it('каждая экосистема в порядке разбора опознаётся по каждому своему манифесту', () => {
    for (const eco of ORDER) {
      for (const manifest of eco.manifests) {
        const found = detectEcosystem(set(manifest));
        ok(found !== null, `${eco.id}: манифест ${manifest} не опознан`);
        // Опознаться может более ранняя экосистема с тем же манифестом — но не позже:
        // порядок обязан быть детерминированным.
        ok(
          ORDER.indexOf(found) <= ORDER.indexOf(eco),
          `${eco.id}: манифест ${manifest} увёл к более поздней ${found.id}`,
        );
      }
    }
  });

  it('у каждой экосистемы есть команда сборки хотя бы на своём манифесте', () => {
    for (const eco of ORDER) {
      const first = eco.manifests[0] ?? '';
      const cmds = eco.commands({ files: set(first), packageJson: null });
      ok(cmds !== null, `${eco.id}: команд нет`);
      ok(cmds.build.trim() !== '', `${eco.id}: пустая команда сборки`);
    }
  });

  it('идентификаторы экосистем уникальны', () => {
    const ids = ORDER.map((e) => e.id);
    strictEqual(new Set(ids).size, ids.length);
  });

  it('обёртка gradlew выигрывает у обычного gradle', () => {
    const s = detectBuildSystem(set('gradlew', 'build.gradle'), null);
    ok(s !== null);
    ok(s.build.includes('./gradlew'));
  });

  it('package.json выигрывает у tsconfig.json', () => {
    const s = detectBuildSystem(set('package.json', 'tsconfig.json'), '{"scripts":{"build":"vite build"}}');
    strictEqual(s?.build, 'npm run build');
  });

  it('tsconfig без build-скрипта даёт tsc, а без package.json — отдельную экосистему', () => {
    strictEqual(
      detectBuildSystem(set('package.json', 'tsconfig.json'), '{"scripts":{"lint":"x"}}')?.build,
      'npx --no-install tsc --noEmit',
    );
    strictEqual(detectEcosystem(set('tsconfig.json'))?.id, 'tsconfig');
    strictEqual(detectBuildSystem(set('tsconfig.json'), null)?.build, 'npx --no-install tsc --noEmit');
  });

  it('package.json без build и test скриптов всё равно даёт команду', () => {
    const s = detectBuildSystem(set('package.json'), '{"name":"x"}');
    strictEqual(s?.build, 'npm run build --if-present');
    strictEqual(s.test, null);
  });

  it('каталог зависимостей выражен путём, а не булевым признаком npm', () => {
    strictEqual(detectBuildSystem(set('package.json'), '{"scripts":{"build":"x"}}')?.depsDir, 'node_modules');
    strictEqual(detectBuildSystem(set('go.mod'), null)?.depsDir, null);
    strictEqual(detectBuildSystem(set('composer.json'), null)?.depsDir, 'vendor');
  });

  it('каталог без единого манифеста экосистемы не имеет', () => {
    strictEqual(detectEcosystem(set('README.md')), null);
    strictEqual(detectBuildSystem(set('README.md'), null), null);
  });

  it('проверка синтаксиса ищется по расширению файла', () => {
    strictEqual(syntaxCheckerFor('src/a.py')?.id, 'python');
    strictEqual(syntaxCheckerFor('src/a.go')?.id, 'go');
    strictEqual(syntaxCheckerFor('src/a.mjs')?.id, 'node');
    // У JVM дешёвой проверки синтаксиса нет — и притворяться, что есть, нельзя.
    strictEqual(syntaxCheckerFor('src/A.java'), null);
    strictEqual(syntaxCheckerFor('README'), null);
  });

  it('проверка синтаксиса получает путь аргументом, а не строкой команды', () => {
    const check = syntaxCheckerFor('src/a.py')?.syntaxCheck;
    ok(check !== undefined);
    const { cmd, args } = check('/tmp/a b.py');
    ok(cmd.trim() !== '');
    ok(args.includes('/tmp/a b.py'), 'путь обязан быть отдельным аргументом');
  });

  it('python не пишет .pyc: иначе scope-гейт увидел бы правку файлов вне плана', () => {
    const check = syntaxCheckerFor('src/a.py')?.syntaxCheck;
    ok(check !== undefined);
    const { args } = check('/tmp/a.py');
    strictEqual(
      args.some((a) => a.includes('py_compile')),
      false,
    );
  });

  it('сводные справочники непусты и собраны без дублей', () => {
    ok(CODE_EXTENSIONS.has('.py') && CODE_EXTENSIONS.has('.java') && CODE_EXTENSIONS.has('.ts'));
    strictEqual(new Set(DISABLE_MARKERS).size, DISABLE_MARKERS.length);
    strictEqual(new Set(TEST_DECLARATIONS).size, TEST_DECLARATIONS.length);
    ok(DISABLE_MARKERS.includes('@Disabled') && DISABLE_MARKERS.includes('@pytest.mark.skip'));
  });
});
