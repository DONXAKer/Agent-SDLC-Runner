import type { Ecosystem } from './types.ts';

/**
 * Stack идёт ПЕРЕД Cabal (см. порядок в `index.ts`): `stack.yaml` фиксирует резолвер и
 * версию компилятора в репозитории, тогда как голый `cabal` собирает тем, что оказалось
 * на машине. Тот же принцип, что у `gradlew` перед `gradle`.
 *
 * Типчекер без сборки не выдумываем: типы проверяет сам GHC внутри `build`, отдельного
 * общепринятого прогона «только типы» у экосистемы нет (`ghc -fno-code` без package env
 * падает на любом проекте с зависимостями — красный по несуществующей причине).
 */
const hspec = {
  disableMarkers: ['xit ', 'xdescribe ', 'xspecify '],
  testDecl: ['it ', 'describe ', 'specify '],
} as const;

export const stack: Ecosystem = {
  id: 'stack',
  label: 'Haskell (Stack)',
  manifests: ['stack.yaml'],
  commands: () => ({ build: 'stack build --fast', test: 'stack test', depsDir: '.stack-work' }),
  codeExt: ['.hs', '.lhs'],
  // hlint ставится отдельно от toolchain: нет на машине → честный ⏭ от гейта.
  lint: (files) => ({ cmd: 'hlint', args: [...files], scope: 'files' }),
  funcDecl: [/^\s*([a-z]\w*)\s*::/],
  ...hspec,
};

export const cabal: Ecosystem = {
  id: 'cabal',
  label: 'Haskell (Cabal)',
  manifests: ['cabal.project'],
  commands: () => ({ build: 'cabal build', test: 'cabal test', depsDir: 'dist-newstyle' }),
  codeExt: ['.hs', '.lhs'],
  lint: (files) => ({ cmd: 'hlint', args: [...files], scope: 'files' }),
  funcDecl: [/^\s*([a-z]\w*)\s*::/],
  ...hspec,
};
