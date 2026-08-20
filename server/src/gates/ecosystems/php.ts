import type { Ecosystem } from './types.ts';

export const php: Ecosystem = {
  id: 'php',
  label: 'PHP',
  manifests: ['composer.json'],
  commands: () => ({
    // `composer validate` проверяет корректность composer.json, а НЕ код: гейт «Сборка»
    // зеленел на проекте с не разбирающимся `.php`. Компиляции у PHP нет, поэтому шага
    // сборки нет — и гейт уходит на `php -l` по изменённым файлам, который хотя бы
    // проверяет то, ради чего его зовут.
    build: null,
    test: 'vendor/bin/phpunit',
    depsDir: 'vendor',
  }),
  codeExt: ['.php'],
  syntaxCheck: (file) => ({ cmd: 'php', args: ['-l', file] }),
  lint: (files) => ({ cmd: 'vendor/bin/phpcs', args: [...files], scope: 'files' }),
  funcDecl: [/^\s*function\s+([A-Za-z_]\w*)/],
  disableMarkers: ['@group disabled', '$this->markTestSkipped('],
  testDecl: ['function test', '@test'],
};
