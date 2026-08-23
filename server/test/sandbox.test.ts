/**
 * Песочница: разбор спеки, детерминизм генератора и адресация по `cwd`.
 *
 * Живой Docker сюда не завязан — на этом уровне проверяется то, что не зависит от демона:
 * спека читается строго, один и тот же вход всегда даёт один и тот же тег образа, а реестр
 * находит песочницу проекта по любому подкаталогу его `cwd`. Сборка/старт контейнера — уже
 * интеграционный сценарий, ему свой тест с явным пропуском без Docker.
 */

import { deepStrictEqual, strictEqual, throws } from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';

import { buildDockerfile, imageTag, specHash } from '../src/sandbox/dockerfile.ts';
import { hostMountSource } from '../src/sandbox/dockerSandbox.ts';
import {
  findSandboxForCwd,
  _resetSandboxRegistryForTests,
  _setSandboxForTests,
} from '../src/sandbox/registry.ts';
import { parseSandboxSpec, SandboxSpecError, loadSandboxSpec } from '../src/sandbox/spec.ts';
import { preflightBlockers } from '../src/sandbox/preflight.ts';
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
});
