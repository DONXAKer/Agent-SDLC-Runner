import type { Ecosystem } from './types.ts';

export const ruby: Ecosystem = {
  id: 'ruby',
  label: 'Ruby',
  manifests: ['Gemfile', 'Rakefile', '.rspec'],
  commands: (env) => ({
    // Шага сборки у Ruby нет. Прежняя `ruby -e "true"` не собирала ничего, а вдобавок
    // отклонялась полом безопасности как однострочник интерпретатора — обязательный гейт
    // «Сборка» был выключен навсегда. `null` уводит его на `ruby -c` по изменённым файлам.
    build: null,
    test: env.files.has('.rspec') || env.files.has('Gemfile') ? 'bundle exec rspec' : null,
    depsDir: null,
  }),
  codeExt: ['.rb'],
  syntaxCheck: (file) => ({ cmd: 'ruby', args: ['-c', file] }),
  funcDecl: [/^\s*def\s+([A-Za-z_]\w*)/],
  disableMarkers: ['xit ', 'xdescribe ', 'skip '],
  testDecl: ['it ', 'def test_'],
};
