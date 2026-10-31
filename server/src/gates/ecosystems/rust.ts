import type { Ecosystem } from './types.ts';

export const cargo: Ecosystem = {
  id: 'cargo',
  label: 'Cargo',
  manifests: ['Cargo.toml'],
  commands: () => ({ build: 'cargo check --all-targets', test: 'cargo test', depsDir: null }),
  codeExt: ['.rs'],
  lint: () => ({ cmd: 'cargo', args: ['clippy', '--all-targets', '--', '-D', 'warnings'], scope: 'module' }),
  // Совпадает с командой сборки — у cargo «проверить» и «собрать» это один проход
  // компилятора; отдельное поле нужно, чтобы гейт «Типы» работал наравне с другими
  // стеками, а не чтобы сэкономить время.
  typecheck: () => ({ cmd: 'cargo', args: ['check', '--all-targets'] }),
  funcDecl: [/^\s*(?:pub\s+)?fn\s+([A-Za-z_]\w*)/],
  disableMarkers: ['#[ignore]'],
  testDecl: ['#[test]'],
};
