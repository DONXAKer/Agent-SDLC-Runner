import type { Ecosystem } from './types.ts';

export const cargo: Ecosystem = {
  id: 'cargo',
  label: 'Cargo',
  manifests: ['Cargo.toml'],
  commands: () => ({ build: 'cargo check --all-targets', test: 'cargo test', depsDir: null }),
  codeExt: ['.rs'],
  disableMarkers: ['#[ignore]'],
  testDecl: ['#[test]'],
};
