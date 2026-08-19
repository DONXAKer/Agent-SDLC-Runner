import type { Ecosystem } from './types.ts';

export const ruby: Ecosystem = {
  id: 'ruby',
  label: 'Ruby',
  manifests: ['Gemfile', 'Rakefile', '.rspec'],
  commands: (env) => ({
    build: 'ruby -e "true"',
    test: env.files.has('.rspec') || env.files.has('Gemfile') ? 'bundle exec rspec' : null,
    depsDir: null,
  }),
  codeExt: ['.rb'],
  syntaxCheck: (file) => ({ cmd: 'ruby', args: ['-c', file] }),
  funcDecl: [/^\s*def\s+([A-Za-z_]\w*)/],
  disableMarkers: ['xit ', 'xdescribe ', 'skip '],
  testDecl: ['it ', 'def test_'],
};
