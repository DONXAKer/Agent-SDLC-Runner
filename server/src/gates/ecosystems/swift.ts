import type { Ecosystem } from './types.ts';

export const swift: Ecosystem = {
  id: 'swift',
  label: 'Swift',
  manifests: ['Package.swift'],
  commands: () => ({ build: 'swift build', test: 'swift test', depsDir: '.build' }),
  codeExt: ['.swift'],
  // `swiftc -parse` разбирает файл и печатает синтаксические ошибки, не компилируя —
  // тот же уровень дешёвой проверки, что `gofmt -e` даёт для Go.
  syntaxCheck: (file) => ({ cmd: 'swiftc', args: ['-parse', file] }),
  // SwiftLint принимает пути аргументами — проверяется только изменённое, как eslint.
  // Нет на машине → честный ⏭ от гейта, а не выдуманный ✅.
  lint: (files) => ({ cmd: 'swiftlint', args: ['lint', ...files], scope: 'files' }),
  funcDecl: [/^\s*(?:public\s+|private\s+|internal\s+|static\s+)*func\s+([A-Za-z_]\w*)/],
  // `XCTSkip` — XCTest; `.disabled(` — атрибут `@Test(.disabled(...))` фреймворка Swift
  // Testing. Оба — законные способы отключить тест без удаления объявления.
  disableMarkers: ['XCTSkip', '.disabled('],
  // `func test` — соглашение имён XCTest; `@Test` — атрибут Swift Testing.
  testDecl: ['func test', '@Test'],
};
