/**
 * Реестр экосистем: порядок разбора и производные от него справочники.
 *
 * Добавление языка — это новый файл рядом и одна строка в `ORDER`. Ни `logic.ts`, ни
 * `builtin/index.ts` при этом не меняются: раньше знание о языке жило в лестнице `if`,
 * в поле, прибитом к npm, и в четырёх закрытых регулярках, и пропустить одно из четырёх
 * мест было проще, чем заметить это.
 */

import { dotnet } from './dotnet.ts';
import { go } from './go.ts';
import { gradle, gradleWrapper, maven } from './jvm.ts';
import { node, typescriptOnly } from './node.ts';
import { php } from './php.ts';
import { python } from './python.ts';
import { ruby } from './ruby.ts';
import { cargo } from './rust.ts';
import type { BuildSystem, Ecosystem, EcosystemEnv } from './types.ts';

export type { BuildSystem, Ecosystem, EcosystemEnv } from './types.ts';

/**
 * Порядок значим и проверяется тестами.
 *
 * `gradlew` перед `gradle`: обёртка фиксирует версию сборщика в репозитории. `package.json`
 * перед `tsconfig.json`: собственный build-скрипт — то, чем проект реально собирается.
 * Python идёт последним из-за широкого набора манифестов (`setup.cfg` встречается и в
 * репозиториях, собираемых не питоном).
 */
export const ORDER: readonly Ecosystem[] = [
  gradleWrapper,
  gradle,
  maven,
  go,
  cargo,
  node,
  typescriptOnly,
  php,
  dotnet,
  ruby,
  python,
];

/** Экосистема каталога по составу файлов. `null` — ни одного манифеста. */
export function detectEcosystem(files: ReadonlySet<string>): Ecosystem | null {
  return ORDER.find((e) => e.manifests.some((m) => files.has(m))) ?? null;
}

/**
 * Команды сборки и тестов по составу каталога. `null` — собирать нечем.
 *
 * Сигнатура сохранена от прежнего `detectBuildSystem`: вызывающие читают `package.json`
 * сами, потому что в этом модуле файловой системы нет.
 */
export function detectBuildSystem(
  files: ReadonlySet<string>,
  packageJson: string | null,
): BuildSystem | null {
  const eco = detectEcosystem(files);
  if (eco === null) return null;
  return eco.commands({ files, packageJson } satisfies EcosystemEnv);
}

/** Расширения исходников всех известных экосистем — для гейтов, отличающих код от прочего. */
export const CODE_EXTENSIONS: ReadonlySet<string> = new Set(ORDER.flatMap((e) => e.codeExt));

/**
 * Экосистемы, которым принадлежит файл — по расширению. Пусто — язык неизвестен.
 *
 * Список, а не одна: `.js` знает и node, и ничего больше, но `.h` принадлежит сразу
 * нескольким, и сужать до первой попавшейся было бы враньём.
 */
function ecosystemsOf(file: string): readonly Ecosystem[] {
  const dot = file.lastIndexOf('.');
  if (dot < 0) return [];
  const ext = file.slice(dot).toLowerCase();
  return ORDER.filter((e) => e.codeExt.includes(ext));
}

/**
 * Маркеры отключённого теста для КОНКРЕТНОГО файла — по его языку.
 *
 * Раньше здесь склеивались маркеры всех экосистем сразу и сравнивались подстрокой с любой
 * строкой любого файла. Ruby приносил `'it '`, `'skip '`, `'xit '`, PHP — `'function test'`,
 * и обычная TypeScript-строка `let skip = shouldSkip(x)` роняла обязательный гейт
 * «Анти-обход тест-гейта», а удаление строк со словами `limit`/`unit`/`submit` читалось как
 * «тесты выкинули». Зелёный вердикт был недостижим на любом обычном витке.
 *
 * Для файла неизвестного языка маркеров нет: молчание честнее, чем красный по чужому языку.
 */
export function disableMarkersFor(file: string): readonly string[] {
  return [...new Set(ecosystemsOf(file).flatMap((e) => e.disableMarkers))];
}

/** Признаки объявления теста для конкретного файла — по его языку. См. `disableMarkersFor`. */
export function testDeclarationsFor(file: string): readonly string[] {
  return [...new Set(ecosystemsOf(file).flatMap((e) => e.testDecl))];
}

/**
 * Имена функций, объявленных в строке. Пусто — объявления в строке нет.
 *
 * Формы берутся из реестра: закрытый список регулярок в гейте был бы четвёртым местом,
 * куда надо не забыть дописать язык.
 */
export function declaredFunctionNames(line: string): string[] {
  const out: string[] = [];
  for (const eco of ORDER) {
    for (const re of eco.funcDecl ?? []) {
      const m = re.exec(line);
      const name = m?.[1];
      if (name !== undefined && !out.includes(name)) out.push(name);
    }
  }
  return out;
}

/**
 * Экосистема, умеющая проверить синтаксис файла по его расширению. `null` — такой нет.
 *
 * Ищется по расширению, а не по манифестам каталога: запасная проверка синтаксиса
 * применяется к изменённым файлам витка, которые могут лежать в разных модулях.
 */
export function syntaxCheckerFor(file: string): Ecosystem | null {
  const dot = file.lastIndexOf('.');
  if (dot < 0) return null;
  const ext = file.slice(dot).toLowerCase();
  return (
    ORDER.find(
      (e) => e.syntaxCheck !== undefined && (e.syntaxCheckExt ?? e.codeExt).includes(ext),
    ) ?? null
  );
}
