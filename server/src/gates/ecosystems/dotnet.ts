import type { Ecosystem } from './types.ts';

export const dotnet: Ecosystem = {
  id: 'dotnet',
  label: '.NET',
  manifests: ['global.json'],
  commands: () => ({ build: 'dotnet build -v q', test: 'dotnet test -v q', depsDir: null }),
  codeExt: ['.cs'],
  // Линт-пресета намеренно нет: анализаторы и их строгость задаются в проектном файле
  // (.csproj/.editorconfig), и любая команда рантайма работала бы мимо этой
  // конфигурации. Своя команда — через `lint` в профиле модуля. Проверку типов делает
  // `dotnet build`, отдельного общепринятого типчекера у .NET нет.
  disableMarkers: ['[Ignore]', 'Skip ='],
  testDecl: ['[Fact]', '[Test]', '[Theory]'],
};
