import type { Ecosystem } from './types.ts';

/**
 * Обёртка `gradlew` идёт отдельной экосистемой и ПЕРЕД обычным Gradle: она фиксирует
 * версию сборщика в репозитории, тогда как `gradle` из PATH — какая на машине окажется.
 */
export const gradleWrapper: Ecosystem = {
  id: 'gradle-wrapper',
  label: 'Gradle (обёртка репозитория)',
  manifests: ['gradlew'],
  commands: () => ({
    build: 'sh ./gradlew compileJava compileTestJava --console=plain -q',
    test: 'sh ./gradlew test --console=plain -q',
    depsDir: null,
  }),
  codeExt: ['.java', '.kt', '.kts', '.scala', '.groovy'],
  disableMarkers: ['@Disabled', '@Ignore'],
  testDecl: ['@Test'],
};

export const gradle: Ecosystem = {
  id: 'gradle',
  label: 'Gradle',
  manifests: ['build.gradle', 'build.gradle.kts'],
  commands: () => ({
    build: 'gradle compileJava compileTestJava --console=plain -q',
    test: 'gradle test --console=plain -q',
    depsDir: null,
  }),
  codeExt: ['.java', '.kt', '.kts', '.scala', '.groovy'],
  disableMarkers: ['@Disabled', '@Ignore'],
  testDecl: ['@Test'],
};

export const maven: Ecosystem = {
  id: 'maven',
  label: 'Maven',
  manifests: ['pom.xml'],
  commands: () => ({ build: 'mvn -q -B test-compile', test: 'mvn -q -B test', depsDir: null }),
  codeExt: ['.java', '.kt', '.scala', '.groovy'],
  disableMarkers: ['@Disabled', '@Ignore'],
  testDecl: ['@Test'],
};
