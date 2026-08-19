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

/** Маркеры отключённого теста, собранные по всем экосистемам. */
export const DISABLE_MARKERS: readonly string[] = [
  ...new Set(ORDER.flatMap((e) => e.disableMarkers)),
];

/** Признаки объявления теста, собранные по всем экосистемам. */
export const TEST_DECLARATIONS: readonly string[] = [
  ...new Set(ORDER.flatMap((e) => e.testDecl)),
];

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
  return ORDER.find((e) => e.syntaxCheck !== undefined && e.codeExt.includes(ext)) ?? null;
}
