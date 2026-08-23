/**
 * Разбор и валидация `.sdlc/sandbox.json`.
 *
 * Снисходительность здесь не нужна — в отличие от `gates.md`, файл не редактируется
 * человеком построчно в markdown-редакторе, а либо пишется автодетектом (появится позже),
 * либо правится один раз при заведении проекта. Строгий разбор ловит опечатку в имени
 * тулчейна сразу, а не тем, что верификация тихо прогоняется без него.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { KNOWN_JDK_DIST } from './dockerfile.ts';
import type { SandboxSpec } from './types.ts';

export class SandboxSpecError extends Error {}

const KNOWN_TOOLCHAINS = new Set(['jdk', 'node']);
const KNOWN_DOCKER = new Set(['none', 'socket']);

// Версия тулчейна и имя apt-пакета попадают в текст генерируемого Dockerfile
// (`dockerfile.ts::jdkLayer`/`nodeLayer`/`buildDockerfile`) как есть, без экранирования —
// белый список символов здесь и есть граница: строка вида `21\nRUN curl … | sh` не пройдёт
// эту проверку и не дойдёт до подстановки в `COPY --from=`/`RUN apt-get install`.
const VERSION_RE = /^[0-9][0-9A-Za-z_.+-]*$/;
const APT_PACKAGE_RE = /^[a-zA-Z0-9][a-zA-Z0-9+.-]*$/;
const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

function assertToolchain(name: string, v: unknown): void {
  if (typeof v !== 'object' || v === null) {
    throw new SandboxSpecError(`toolchains.${name} обязан быть объектом`);
  }
  const version = (v as Record<string, unknown>).version;
  if (typeof version !== 'string' || !VERSION_RE.test(version)) {
    throw new SandboxSpecError(
      `toolchains.${name}.version обязан быть версией вида «21» или «21.0.5» (только цифры, буквы, точки, «_+-», начинается с цифры)`,
    );
  }
  const dist = (v as Record<string, unknown>).dist;
  if (dist !== undefined && (typeof dist !== 'string' || !KNOWN_JDK_DIST.has(dist))) {
    throw new SandboxSpecError(
      `toolchains.${name}.dist «${String(dist)}» не поддерживается — известны: ${[...KNOWN_JDK_DIST].join(', ')}`,
    );
  }
}

export function parseSandboxSpec(raw: string, sourcePath: string): SandboxSpec {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (e) {
    throw new SandboxSpecError(`${sourcePath}: не разобрался как JSON — ${(e as Error).message}`);
  }
  if (typeof json !== 'object' || json === null) {
    throw new SandboxSpecError(`${sourcePath}: верхний уровень обязан быть объектом`);
  }
  const o = json as Record<string, unknown>;

  if (typeof o.base !== 'string' || o.base.trim() === '') {
    throw new SandboxSpecError(`${sourcePath}: поле «base» обязано быть непустой строкой`);
  }

  const toolchains = o.toolchains;
  if (typeof toolchains !== 'object' || toolchains === null) {
    throw new SandboxSpecError(`${sourcePath}: поле «toolchains» обязано быть объектом`);
  }
  for (const key of Object.keys(toolchains as object)) {
    if (!KNOWN_TOOLCHAINS.has(key)) {
      throw new SandboxSpecError(
        `${sourcePath}: неизвестный тулчейн «${key}» — известны: ${[...KNOWN_TOOLCHAINS].join(', ')}`,
      );
    }
    assertToolchain(key, (toolchains as Record<string, unknown>)[key]);
  }

  if (o.docker !== undefined && !KNOWN_DOCKER.has(o.docker as string)) {
    throw new SandboxSpecError(`${sourcePath}: «docker» обязан быть одним из: ${[...KNOWN_DOCKER].join(', ')}`);
  }

  if (o.apt !== undefined) {
    if (!Array.isArray(o.apt) || o.apt.some((x) => typeof x !== 'string')) {
      throw new SandboxSpecError(`${sourcePath}: «apt» обязан быть списком строк`);
    }
    for (const pkg of o.apt as string[]) {
      if (!APT_PACKAGE_RE.test(pkg)) {
        throw new SandboxSpecError(
          `${sourcePath}: «${pkg}» не похоже на имя apt-пакета (буквы, цифры, «+.-», начинается с буквы/цифры) — попадает в RUN apt-get install как есть`,
        );
      }
    }
  }

  if (o.env !== undefined) {
    if (typeof o.env !== 'object' || o.env === null || Array.isArray(o.env)) {
      throw new SandboxSpecError(`${sourcePath}: «env» обязан быть объектом строка→строка`);
    }
    for (const [k, v] of Object.entries(o.env as Record<string, unknown>)) {
      if (!ENV_KEY_RE.test(k)) {
        throw new SandboxSpecError(`${sourcePath}: env-ключ «${k}» не похож на имя переменной окружения`);
      }
      if (typeof v !== 'string') {
        throw new SandboxSpecError(`${sourcePath}: env.${k} обязан быть строкой`);
      }
      if (v.includes('\n') || v.includes('\r')) {
        throw new SandboxSpecError(
          `${sourcePath}: env.${k} содержит перевод строки — Dockerfile-инструкция ENV обязана быть одной строкой`,
        );
      }
    }
  }

  if (o.warmup !== undefined && (!Array.isArray(o.warmup) || o.warmup.some((x) => typeof x !== 'string'))) {
    throw new SandboxSpecError(`${sourcePath}: «warmup» обязан быть списком строк`);
  }

  if (o.caches !== undefined && (!Array.isArray(o.caches) || o.caches.some((x) => typeof x !== 'string'))) {
    throw new SandboxSpecError(`${sourcePath}: «caches» обязан быть списком строк`);
  }

  if (o.network !== undefined && o.network !== 'none') {
    throw new SandboxSpecError(`${sourcePath}: «network» поддерживает только значение «none»`);
  }

  if (o.probes !== undefined) {
    if (!Array.isArray(o.probes)) throw new SandboxSpecError(`${sourcePath}: «probes» обязан быть списком`);
    for (const p of o.probes) {
      if (
        typeof p !== 'object' ||
        p === null ||
        typeof (p as Record<string, unknown>).cmd !== 'string' ||
        typeof (p as Record<string, unknown>).expect !== 'string'
      ) {
        throw new SandboxSpecError(`${sourcePath}: каждая проба — { cmd: string, expect: string }`);
      }
    }
  }

  return json as SandboxSpec;
}

export const SANDBOX_SPEC_FILENAME = 'sandbox.json';

/** Путь, где ожидается спека проекта — рядом с `gates.md`. */
export function sandboxSpecPath(projectRoot: string): string {
  return join(projectRoot, '.sdlc', SANDBOX_SPEC_FILENAME);
}

/** `null` — спеки нет, проект работает по-старому (`LocalSandbox`). */
export function loadSandboxSpec(projectRoot: string): SandboxSpec | null {
  const p = sandboxSpecPath(projectRoot);
  if (!existsSync(p)) return null;
  return parseSandboxSpec(readFileSync(p, 'utf8'), p);
}
