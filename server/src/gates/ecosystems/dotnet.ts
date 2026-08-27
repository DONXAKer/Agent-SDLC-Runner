import type { Ecosystem } from './types.ts';

export const dotnet: Ecosystem = {
  id: 'dotnet',
  label: '.NET',
  manifests: ['global.json'],
  commands: () => ({ build: 'dotnet build -v q', test: 'dotnet test -v q', depsDir: null }),
  codeExt: ['.cs'],
  disableMarkers: ['[Ignore]', 'Skip ='],
  testDecl: ['[Fact]', '[Test]', '[Theory]'],
};
