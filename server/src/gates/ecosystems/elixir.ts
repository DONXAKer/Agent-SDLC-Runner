import type { Ecosystem } from './types.ts';

export const elixir: Ecosystem = {
  id: 'elixir',
  label: 'Elixir',
  manifests: ['mix.exs'],
  commands: () => ({ build: 'mix compile', test: 'mix test', depsDir: 'deps' }),
  codeExt: ['.ex', '.exs'],
  // Линт- и тип-пресетов намеренно нет: credo и dialyzer — зависимости проекта, а не
  // часть toolchain. Угаданная `mix credo` на проекте без credo упала бы с ненулевым
  // кодом — красный гейт там, где правильный ответ «инструмента нет». Своя команда —
  // через `lint`/`typecheck` в профиле модуля.
  funcDecl: [/^\s*def\s+([a-z_]\w*)/, /^\s*defp\s+([a-z_]\w*)/],
  disableMarkers: ['@tag :skip', '@tag skip'],
  testDecl: ['test "', 'describe "'],
};
