import type { Ecosystem } from './types.ts';

/**
 * Node/TypeScript. Единственная экосистема с ветвлением по содержимому манифеста, поэтому
 * и живёт функцией, а не таблицей команд.
 *
 * `package.json` идёт ПЕРЕД `tsconfig.json` (см. порядок в `index.ts`): собственный
 * build-скрипт проекта — то, чем он реально собирается (esbuild/vite/webpack), тогда как
 * `npx tsc --noEmit` тянет tsc из сети и падает, если его нет локально. tsc остаётся
 * запасным вариантом для проектов с tsconfig, но без build-скрипта.
 */
export const node: Ecosystem = {
  id: 'node',
  label: 'Node.js',
  manifests: ['package.json'],
  commands: (env) => {
    const scripts = env.packageJson ?? '';
    const hasBuild = /"build"\s*:/.test(scripts);
    const hasTest = /"test"\s*:/.test(scripts);
    const hasTsconfig = env.files.has('tsconfig.json');

    if (hasBuild || hasTest || hasTsconfig) {
      return {
        build: hasBuild
          ? 'npm run build'
          : hasTsconfig
            ? 'npx --no-install tsc --noEmit'
            : 'npm run build --if-present',
        test: hasTest ? 'npm test --silent' : null,
        depsDir: 'node_modules',
      };
    }
    return { build: 'npm run build --if-present', test: null, depsDir: 'node_modules' };
  },
  codeExt: ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'],
  // `node --check` на `.js` с `import` возвращает 0 даже для битого файла, а на `.mjs`
  // работает корректно — поэтому ESM и JSX отсеиваются по фактическому тексту ошибки в
  // `builtin/index.ts`, а не здесь.
  syntaxCheck: (file) => ({ cmd: process.execPath, args: ['--check', file] }),
  disableMarkers: [
    'it.skip(',
    'describe.skip(',
    'test.skip(',
    'xit(',
    'xdescribe(',
    '.only(',
  ],
  testDecl: ['it(', 'test(', 'describe('],
};

/**
 * Проект с `tsconfig.json`, но без `package.json`: собрать нечем, кроме tsc.
 *
 * Отдельной экосистемой, а не веткой внутри `node`, потому что вопрос «это модуль?»
 * решается по манифестам, и `tsconfig.json` обязан числиться манифестом сам по себе.
 */
export const typescriptOnly: Ecosystem = {
  ...node,
  id: 'tsconfig',
  label: 'TypeScript (без package.json)',
  manifests: ['tsconfig.json'],
  commands: () => ({ build: 'npx --no-install tsc --noEmit', test: null, depsDir: 'node_modules' }),
};
