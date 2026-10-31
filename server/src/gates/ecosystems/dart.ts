import type { Ecosystem } from './types.ts';

/**
 * Dart/Flutter — одной экосистемой на оба мира. Отличить Flutter-проект от чистого Dart
 * можно только по СОДЕРЖИМОМУ `pubspec.yaml`, а реестр видит лишь имена файлов
 * (`package.json` — единственный манифест, чей текст сюда доходит). Поэтому раннер
 * тестов не угадывается: `dart test` на Flutter-проекте падает по чужой причине, а
 * `flutter test` на чистом Dart — по несуществующему инструменту. Своя команда — через
 * `test` в профиле модуля или строку в `.sdlc/gates.md`.
 */
export const dart: Ecosystem = {
  id: 'dart',
  label: 'Dart/Flutter',
  manifests: ['pubspec.yaml'],
  commands: () => ({
    // Шага сборки в общем виде нет: `dart compile exe` требует знать точку входа,
    // `flutter build` — целевую платформу. Честный `null` уводит «Сборку» на
    // `dart analyze` по изменённым файлам — он хотя бы проверяет код.
    build: null,
    test: null,
    depsDir: '.dart_tool',
  }),
  codeExt: ['.dart'],
  // `dart analyze` принимает и отдельные файлы: проверка сильнее обычного
  // синтаксического чека — разбор и типы в одном проходе анализатора.
  syntaxCheck: (file) => ({ cmd: 'dart', args: ['analyze', file] }),
  // Анализатор и есть типчекер Dart. Отдельный линтер не выдумываем: правила задаются
  // `analysis_options.yaml` проекта, и вторая команда проверяла бы не ту конфигурацию.
  typecheck: () => ({ cmd: 'dart', args: ['analyze'] }),
  disableMarkers: ['@Skip'],
  testDecl: ['test(', 'testWidgets('],
};
