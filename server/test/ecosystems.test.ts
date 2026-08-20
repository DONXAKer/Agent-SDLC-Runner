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
  disableMarkersFor,
  ORDER,
  testDeclarationsFor,
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

  it('команда сборки либо настоящая, либо честно отсутствует', () => {
    for (const eco of ORDER) {
      const first = eco.manifests[0] ?? '';
      const cmds = eco.commands({ files: set(first), packageJson: null });
      ok(cmds !== null, `${eco.id}: команд нет`);
      // `null` — легальный ответ для языка без компиляции, а вот пустая или
      // ничего-не-делающая строка нет: она дала бы `✅` обязательному гейту, не проверив
      // ни строки (так было у Ruby с `ruby -e "true"`).
      if (cmds.build !== null) ok(cmds.build.trim() !== '', `${eco.id}: пустая команда сборки`);
    }
  });

  it('языки без компиляции не выдумывают себе шаг сборки', () => {
    // Гейт «Сборка» тогда уходит на пофайловую проверку синтаксиса — она хотя бы
    // проверяет код, в отличие от `composer validate`, смотревшего на composer.json.
    strictEqual(detectBuildSystem(set('Gemfile'), null)?.build, null);
    strictEqual(detectBuildSystem(set('composer.json'), null)?.build, null);
    ok(syntaxCheckerFor('app/a.rb') !== null, 'у ruby обязана остаться проверка синтаксиса');
    ok(syntaxCheckerFor('app/a.php') !== null, 'у php обязана остаться проверка синтаксиса');
  });

  it('node --check не зовётся на TypeScript, который он не разбирает', () => {
    // Проверено прогоном: `node --check` на `const NAME: string = "ок"` возвращает 1 с
    // `Missing initializer in const declaration` и в CJS, и в ESM — то есть объявлял
    // битым любой исправный `.ts`.
    strictEqual(syntaxCheckerFor('src/a.ts'), null);
    strictEqual(syntaxCheckerFor('src/a.tsx'), null);
    strictEqual(syntaxCheckerFor('src/a.mjs')?.id, 'node');
  });

  it('идентификаторы экосистем уникальны', () => {
    const ids = ORDER.map((e) => e.id);
    strictEqual(new Set(ids).size, ids.length);
  });

  it('обёртка gradlew выигрывает у обычного gradle', () => {
    const s = detectBuildSystem(set('gradlew', 'build.gradle'), null);
    ok(s !== null);
    ok(s.build?.includes('./gradlew'));
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

  it('маркеры берутся по языку файла и собраны без дублей', () => {
    ok(CODE_EXTENSIONS.has('.py') && CODE_EXTENSIONS.has('.java') && CODE_EXTENSIONS.has('.ts'));

    const py = disableMarkersFor('a/test_x.py');
    const java = disableMarkersFor('src/XTest.java');
    strictEqual(new Set(py).size, py.length);
    ok(py.includes('@pytest.mark.skip'), 'python не знает своего маркера');
    ok(java.includes('@Disabled'), 'java не знает своего маркера');

    // Главное: маркеры НЕ текут между языками. Пока они склеивались по всем экосистемам,
    // ruby-шные `it `/`skip ` роняли обязательный гейт на любом TypeScript-витке.
    strictEqual(java.includes('@pytest.mark.skip'), false);
    strictEqual(
      disableMarkersFor('src/a.ts').some((m) => m.includes('pytest')),
      false,
    );
    // Неизвестное расширение — молчание, а не красный по чужому языку.
    strictEqual(disableMarkersFor('README.md').length, 0);
    strictEqual(testDeclarationsFor('README.md').length, 0);
  });
});
