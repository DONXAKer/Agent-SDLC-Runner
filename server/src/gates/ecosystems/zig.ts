import type { Ecosystem } from './types.ts';

export const zig: Ecosystem = {
  id: 'zig',
  label: 'Zig',
  manifests: ['build.zig'],
  commands: () => ({ build: 'zig build', test: 'zig build test', depsDir: '.zig-cache' }),
  codeExt: ['.zig'],
  // `zig ast-check` разбирает файл без компиляции — тот же уровень дешёвой проверки,
  // что `gofmt -e` даёт для Go.
  syntaxCheck: (file) => ({ cmd: 'zig', args: ['ast-check', file] }),
  // Маркеров отключённого теста у Zig нет: тест либо есть в `test`-блоке, либо удалён.
  // Пустой список честнее выдуманного маркера.
  disableMarkers: [],
  testDecl: ['test "'],
  funcDecl: [/^\s*(?:pub\s+)?fn\s+([A-Za-z_]\w*)/],
};
