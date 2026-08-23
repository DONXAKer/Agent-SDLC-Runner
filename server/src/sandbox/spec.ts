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

import type { SandboxSpec } from './types.ts';

export class SandboxSpecError extends Error {}

const KNOWN_TOOLCHAINS = new Set(['jdk', 'node']);
const KNOWN_DOCKER = new Set(['none', 'socket']);

function assertToolchain(name: string, v: unknown): void {
  if (typeof v !== 'object' || v === null) {
    throw new SandboxSpecError(`toolchains.${name} обязан быть объектом`);
  }
  const version = (v as Record<string, unknown>).version;
  if (typeof version !== 'string' || version.trim() === '') {
    throw new SandboxSpecError(`toolchains.${name}.version обязан быть непустой строкой`);
  }
  const dist = (v as Record<string, unknown>).dist;
  if (dist !== undefined && typeof dist !== 'string') {
    throw new SandboxSpecError(`toolchains.${name}.dist обязан быть строкой`);
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

  if (o.apt !== undefined && (!Array.isArray(o.apt) || o.apt.some((x) => typeof x !== 'string'))) {
    throw new SandboxSpecError(`${sourcePath}: «apt» обязан быть списком строк`);
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
