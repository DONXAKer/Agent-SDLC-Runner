import type { Ecosystem } from './types.ts';

export const perl: Ecosystem = {
  id: 'perl',
  label: 'Perl',
  manifests: ['cpanfile', 'Makefile.PL'],
  commands: () => ({
    // Шага сборки у Perl нет — `null` уводит «Сборку» на `perl -c` по изменённым файлам.
    build: null,
    test: 'prove -l',
    depsDir: null,
  }),
  codeExt: ['.pl', '.pm', '.t'],
  syntaxCheck: (file) => ({ cmd: 'perl', args: ['-c', file] }),
  // perlcritic — стандарт де-факто, но ставится отдельно от интерпретатора: нет на
  // машине → честный ⏭ от гейта, а не ❌.
  lint: (files) => ({ cmd: 'perlcritic', args: [...files], scope: 'files' }),
  funcDecl: [/^\s*sub\s+([A-Za-z_]\w*)/],
  disableMarkers: ['SKIP:', 'TODO:'],
  testDecl: ['ok(', 'is(', 'subtest('],
};
