/**
 * Логика встроенных гейтов. Каждый кейс здесь — след живого прогона в AI-Workflow,
 * откуда эти проверки портированы: детект модуля по алфавиту брал не тот подпроект,
 * анти-обход срабатывал на собственных правилах в комментариях, scope вменял агенту
 * чужие правки оператора.
 */

import { detectBuildSystem } from '../src/gates/ecosystems/index.ts';
import { deepStrictEqual, ok, strictEqual } from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  diffLines,
  moduleDirsFromPlan,
  invariantViolations,
  publishProblems,
  scopeViolations,
} from '../src/gates/builtin/logic.ts';
import { lastMeaningfulLine } from '../src/gates/shell.ts';

const set = (...f: string[]): Set<string> => new Set(f);

const ROOT = 'D:/work/proj';

describe('детект build-системы', () => {
  it('gradle wrapper предпочитается системному gradle', () => {
    strictEqual(detectBuildSystem(set('gradlew', 'build.gradle'), null)?.build?.includes('./gradlew'), true);
  });

  // Регрессия: `npx tsc --noEmit` тянет tsc из сети и падает, если его нет локально,
  // тогда как собственный build-скрипт — то, чем проект реально собирается.
  it('package.json со скриптом build идёт вперёд tsconfig.json', () => {
    const s = detectBuildSystem(set('package.json', 'tsconfig.json'), '{"scripts":{"build":"vite build"}}');
    strictEqual(s?.build, 'npm run build');
  });

  it('tsconfig без build-скрипта даёт запасной tsc', () => {
    const s = detectBuildSystem(set('package.json', 'tsconfig.json'), '{"scripts":{"lint":"x"}}');
    strictEqual(s?.build, 'npx --no-install tsc --noEmit');
  });

  it('отсутствие тест-скрипта — это «раннера нет», а не «тесты прошли»', () => {
    strictEqual(detectBuildSystem(set('package.json'), '{"scripts":{"build":"x"}}')?.test, null);
    strictEqual(detectBuildSystem(set('go.mod'), null)?.test, 'go test ./...');
  });

  it('пустой каталог build-системой не считается', () => {
    strictEqual(detectBuildSystem(set('README.md'), null), null);
  });
});

describe('каталог модуля выводится из плана', () => {
  const isModule = (d: string): boolean => d === 'vscode-extension' || d === 'frontend';

  // Проверки те же, что охраняли снятый `moduleDirFromPlan`: он вернул одиночный модуль и
  // был ложным зелёным в моно-репо по построению, но выстраданные им регрессии остаются.
  const first = (plan: string[], mod: (d: string) => boolean): string | null =>
    moduleDirsFromPlan(plan, mod)[0] ?? null;

  // Регрессия: перебор подкаталогов по алфавиту брал frontend/, тогда как правки шли
  // в vscode-extension/ — гейт зеленел, не проверив ничего по существу.
  it('берётся модуль правки, а не первый по алфавиту', () => {
    strictEqual(first(['vscode-extension/src/a.ts'], isModule), 'vscode-extension');
  });

  it('поднимается вверх до ближайшего манифеста', () => {
    strictEqual(first(['vscode-extension/src/deep/b.ts'], isModule), 'vscode-extension');
  });

  it('корень берётся, только если модуля по плану не нашлось', () => {
    strictEqual(first(['docs/x.md'], (d) => d === '.'), '.');
    strictEqual(first(['docs/x.md'], () => false), null);
  });

  it('windows-разделители в плане не мешают', () => {
    strictEqual(first(['vscode-extension\\src\\a.ts'], isModule), 'vscode-extension');
  });
});

describe('scope: файлы вне плана', () => {
  it('файл из плана проходит, посторонний — нет', () => {
    const v = scopeViolations(['src/a.ts', 'src/b.ts'], ['src/a.ts'], ROOT);
    deepStrictEqual(v.map((x) => x.path), ['src/b.ts']);
  });

  // Регрессия: совпадение только по имени файла — почти всегда промах модулем,
  // и диагноз «новый файл» отправлял бы исполнителя чинить не то.
  it('совпадение по имени в другом каталоге помечается отдельно', () => {
    const v = scopeViolations(['other/module/Foo.java'], ['src/main/Foo.java'], ROOT);
    strictEqual(v[0]?.sameName, true);
  });

  it('артефакты витка из сверки исключены', () => {
    deepStrictEqual(scopeViolations(['.sdlc/demo/plan.md', 'src/a.ts'], ['src/a.ts'], ROOT), []);
  });

  it('формы записи пути приводятся к одной', () => {
    deepStrictEqual(scopeViolations(['src\\a.ts'], ['./src/a.ts'], ROOT), []);
  });

  // Регрессия: у гейта была своя нормализация, и план с абсолютным путём давал
  // расхождение с PlanScope — запись рантайм разрешал, а гейт печатал «файл вне плана».
  it('абсолютный путь в плане не расходится с PlanScope', () => {
    deepStrictEqual(scopeViolations(['src/a.ts'], [`${ROOT}/src/a.ts`], ROOT), []);
    deepStrictEqual(scopeViolations(['src/a.ts'], [`${ROOT}/src/a.ts: правим тут`], ROOT), []);
  });
});

describe('анти-обход тест-гейта', () => {
  // Настоящая граница тела hunk'а — счётчики `@@ -a,b +c,d @@`, а не факт присутствия
  // `+++`-строки: `diffLines` разбирает патч так же, как весь остальной unified diff в
  // кодовой базе (`server/src/diff/parse.ts`), и без честного заголовка тело для нашего
  // разбора не начинается вовсе — счёт строится по самому body.
  const diff = (body: string): string => {
    const lines = body.split('\n').filter((l) => l !== '');
    const dels = lines.filter((l) => l.startsWith('-')).length;
    const adds = lines.filter((l) => l.startsWith('+')).length;
    return `diff --git a/x b/x\n+++ b/src/FooTest.java\n@@ -1,${dels} +1,${adds} @@\n${body}`;
  };

  it('добавленное отключение теста ловится', () => {
    const v = invariantViolations(diff('+    @Disabled("чиню позже")\n'), []);
    strictEqual(v[0]?.kind, 'test-disabled');
  });

  // Регрессия: греп по содержимому ловил собственные правила гейта, процитированные
  // в комментариях и документации, и гейт превращался в шум.
  it('то же самое в комментарии гейт не роняет', () => {
    deepStrictEqual(invariantViolations(diff('+    // не добавляй @Disabled\n'), []), []);
  });

  it('удаление тестового файла ловится', () => {
    const v = invariantViolations('', ['src/test/java/FooTest.java']);
    strictEqual(v[0]?.kind, 'test-file-deleted');
  });

  it('нетто-убыль деклараций ловится, а прирост — нет', () => {
    const removed = diff('-    @Test\n-    @Test\n+    @Test\n');
    strictEqual(invariantViolations(removed, []).some((v) => v.kind === 'tests-removed'), true);
    const added = diff('-    @Test\n+    @Test\n+    @Test\n');
    strictEqual(invariantViolations(added, []).some((v) => v.kind === 'tests-removed'), false);
  });

  it('секрет в diff ловится в любом файле, не только в коде', () => {
    const d =
      'diff --git a/x b/x\n+++ b/deploy/config.yaml\n@@ -1,0 +1,1 @@\n+  api_key: "sk-abcdefghijklmnop1234"\n';
    strictEqual(invariantViolations(d, [])[0]?.kind, 'secret-in-diff');
  });

  it('правки, не трогающие тесты, гейт не роняют', () => {
    deepStrictEqual(invariantViolations(diff('+    int x = 1;\n'), []), []);
  });

  it('строки заголовков diff за содержимое не принимаются', () => {
    const parsed = diffLines('diff --git a/x b/x\n--- a/src/A.ts\n+++ b/src/A.ts\n@@ -1 +1 @@\n+const a = 1;\n');
    deepStrictEqual(parsed, [{ file: 'src/A.ts', text: '+const a = 1;', added: true }]);
  });
});

describe('предусловия публикации', () => {
  it('основная ветка блокирует публикацию', () => {
    const p = publishProblems({ branch: 'main', commitsAhead: 2, committedFiles: [] });
    ok(p.some((x) => x.includes('protected-branch')));
  });

  it('нечего публиковать — тоже блокировка', () => {
    const p = publishProblems({ branch: 'sdlc/demo', commitsAhead: 0, committedFiles: [] });
    ok(p.some((x) => x.includes('nothing-to-publish')));
  });

  it('артефакты сборки в коммите ловятся', () => {
    const p = publishProblems({
      branch: 'sdlc/demo',
      commitsAhead: 1,
      committedFiles: ['src/a.ts', 'build/out.class', '.env'],
    });
    ok(p.some((x) => x.includes('build-artifacts-committed')));
  });

  it('чистый коммит на ветке задачи проходит', () => {
    deepStrictEqual(
      publishProblems({ branch: 'sdlc/demo', commitsAhead: 1, committedFiles: ['src/a.ts'] }),
      [],
    );
  });

  it('отсутствие вышестоящей ветки не выдаётся за «нечего публиковать»', () => {
    deepStrictEqual(
      publishProblems({ branch: 'sdlc/demo', commitsAhead: null, committedFiles: ['src/a.ts'] }),
      [],
    );
  });
});

describe('последняя содержательная строка вывода', () => {
  it('берётся последняя непустая', () => {
    strictEqual(lastMeaningfulLine('a\nb\n\n  \n'), 'b');
    strictEqual(lastMeaningfulLine(''), '');
  });
});
