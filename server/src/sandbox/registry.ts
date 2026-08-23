/**
 * Реестр живых песочниц, по одной на проект.
 *
 * `runShell` (`gates/shell.ts`) получает только `cwd` команды — часто подкаталог проекта
 * (`backend/`, `frontend/`), а не сам `projectRoot`. Реестр хранит песочницы по корню и
 * ищет по наибольшему совпадающему префиксу, поэтому `runShell` не обязан знать корень
 * заранее и его сигнатура не меняется — существующие вызовы и тесты остаются рабочими без
 * правок.
 *
 * Пустой реестр — сегодняшнее поведение для всех проектов: `findSandboxForCwd` возвращает
 * `null`, и `runShell` идёт локальным путём, как и до появления песочницы.
 */

import { sep } from 'node:path';

import { loadSandboxSpec } from './spec.ts';
import { createDockerSandbox } from './dockerSandbox.ts';
import type { SandboxHandle } from './types.ts';

const active = new Map<string, SandboxHandle>();
const pending = new Map<string, Promise<SandboxHandle | null>>();

function normalize(p: string): string {
  return p.endsWith(sep) ? p.slice(0, -1) : p;
}

export function findSandboxForCwd(cwd: string): SandboxHandle | null {
  let best: { root: string; handle: SandboxHandle } | null = null;
  for (const [root, handle] of active) {
    if (cwd === root || cwd.startsWith(root + sep)) {
      if (best === null || root.length > best.root.length) best = { root, handle };
    }
  }
  return best?.handle ?? null;
}

/**
 * Готовит песочницу проекта, если у него есть `.sdlc/sandbox.json` — иначе не делает
 * ничего и возвращает `null` (проект остаётся на `LocalSandbox` через фолбэк в `runShell`).
 *
 * Идемпотентна: параллельные вызовы для одного проекта дожидаются одной и той же сборки, а
 * не гоняют `docker build` по кругу — конкуренция была реальной: и `gates/run.ts`, и первая
 * команда модели могли позвать это одновременно на старте витка.
 */
export async function ensureSandboxFor(projectRoot: string, projectName: string): Promise<SandboxHandle | null> {
  const root = normalize(projectRoot);
  const existing = active.get(root);
  if (existing !== undefined) return existing;

  const inflight = pending.get(root);
  if (inflight !== undefined) return inflight;

  const promise = (async () => {
    const spec = loadSandboxSpec(root);
    if (spec === null) return null;
    const handle = await createDockerSandbox(root, projectName, spec);
    active.set(root, handle);
    return handle;
  })();

  pending.set(root, promise);
  try {
    return await promise;
  } finally {
    pending.delete(root);
  }
}

export function unregisterSandbox(projectRoot: string): void {
  active.delete(normalize(projectRoot));
}

/** Только для тестов — реестр иначе живёт всё время процесса Runner'а. */
export function _resetSandboxRegistryForTests(): void {
  active.clear();
  pending.clear();
}

/** Только для тестов — регистрирует готовую ручку без похода в Docker, чтобы адресацию
 * `findSandboxForCwd` можно было проверить без живого демона. */
export function _setSandboxForTests(projectRoot: string, handle: SandboxHandle): void {
  active.set(normalize(projectRoot), handle);
}
