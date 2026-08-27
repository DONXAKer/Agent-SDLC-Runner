import type { Ecosystem } from './types.ts';

export const cargo: Ecosystem = {
  id: 'cargo',
  label: 'Cargo',
  manifests: ['Cargo.toml'],
  commands: () => ({ build: 'cargo check --all-targets', test: 'cargo test', depsDir: null }),
  codeExt: ['.rs'],
  lint: () => ({ cmd: 'cargo', args: ['clippy', '--all-targets', '--', '-D', 'warnings'], scope: 'module' }),
  funcDecl: [/^\s*(?:pub\s+)?fn\s+([A-Za-z_]\w*)/],
  disableMarkers: ['#[ignore]'],
  testDecl: ['#[test]'],
};
