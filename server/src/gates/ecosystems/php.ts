import type { Ecosystem } from './types.ts';

export const php: Ecosystem = {
  id: 'php',
  label: 'PHP',
  manifests: ['composer.json'],
  commands: () => ({
    build: 'composer validate --no-check-publish -q',
    test: 'vendor/bin/phpunit',
    depsDir: 'vendor',
  }),
  codeExt: ['.php'],
  syntaxCheck: (file) => ({ cmd: 'php', args: ['-l', file] }),
  disableMarkers: ['@group disabled', '$this->markTestSkipped('],
  testDecl: ['function test', '@test'],
};
