import type { Ecosystem } from './types.ts';

export const go: Ecosystem = {
  id: 'go',
  label: 'Go',
  manifests: ['go.mod'],
  commands: () => ({ build: 'go build ./...', test: 'go test ./...', depsDir: null }),
  codeExt: ['.go'],
  // `gofmt -e` печатает синтаксические ошибки и возвращает ненулевой код; `gofmt -l`
  // проверял бы форматирование, а это другое утверждение — им нельзя подменять «файл
  // вообще разбирается».
  syntaxCheck: (file) => ({ cmd: 'gofmt', args: ['-e', file] }),
  lint: (files) => ({ cmd: 'golangci-lint', args: ['run', './...'], scope: 'module' }),
  // `go vet` компилирует пакеты и проверяет типы без записи бинарей — дешевле
  // `go build ./...`, а по силе проверки для целей гейта «Типы» эквивалентен.
  typecheck: () => ({ cmd: 'go', args: ['vet', './...'] }),
  funcDecl: [/^\s*func\s+([A-Za-z_]\w*)/],
  disableMarkers: ['t.Skip(', 'testing.Short()'],
  testDecl: ['func Test'],
};
