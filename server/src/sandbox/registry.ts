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
import { createDockerSandbox, stopDockerSandbox } from './dockerSandbox.ts';
import type { SandboxHandle } from './types.ts';

const active = new Map<string, SandboxHandle>();
const pending = new Map<string, Promise<SandboxHandle | null>>();
/** Остановка контейнера в процессе — `ensureSandboxFor` ждёт её перед тем, как поднимать
 * новый: см. `stopSandboxForProject`. */
const stopping = new Map<string, Promise<void>>();

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
export async function ensureSandboxFor(
  projectRoot: string,
  projectName: string,
  onWarn?: (message: string) => void,
): Promise<SandboxHandle | null> {
  const root = normalize(projectRoot);

  // Дождаться уже идущей остановки ПЕРЕД тем, как смотреть на `active`/`pending`: без этого
  // окно между `active.delete(root)` (синхронно, в начале `stopSandboxForProject`) и
  // фактическим завершением `docker rm -f` — реальная гонка, а не гипотеза. Воспроизведено
  // руками: `docker run --name X` параллельно с ещё выполняющимся `docker rm -f X` того же
  // имени падает с «Conflict: container name already in use» в большинстве попыток, даже
  // когда обе стороны используют `await` — демон снимает контейнер асинхронно относительно
  // возврата CLI. Оператор, закрывший виток и тут же начавший новый на том же проекте,
  // попадал в это окно на бытовой скорости кликов, не на гипотетической.
  const stoppingPromise = stopping.get(root);
  if (stoppingPromise !== undefined) await stoppingPromise;

  const existing = active.get(root);
  if (existing !== undefined) return existing;

  const inflight = pending.get(root);
  if (inflight !== undefined) return inflight;

  const promise = (async () => {
    const spec = loadSandboxSpec(root);
    if (spec === null) return null;
    const handle = await createDockerSandbox(root, projectName, spec, onWarn);
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

/**
 * Останавливает и удаляет контейнер песочницы проекта — вызывается при закрытии витка
 * (`DELETE /api/runs/:id`), не после каждого этапа: контейнер живёт долго НАРОЧНО, ради
 * тёплого `~/.m2`/`~/.npm` между попытками одного витка, и гасить его на границе каждого
 * этапа обнулило бы этот смысл целиком.
 *
 * Идемпотентна и не бросает: закрытие витка — не место для отказа операции по вине докера,
 * образ остаётся в кэше в любом случае — следующий виток того же проекта просто поднимет
 * контейнер заново без пересборки.
 */
export async function stopSandboxForProject(projectRoot: string, projectName: string): Promise<void> {
  const root = normalize(projectRoot);
  const handle = active.get(root);
  if (handle === undefined) return;
  active.delete(root);

  const promise = (async () => {
    try {
      await stopDockerSandbox(projectName, handle.specHash);
    } catch {
      // Закрытие витка не должно упасть из-за докера — контейнер, оставшийся жить, не хуже
      // того, что уже было ДО появления песочницы (просто трата ресурсов, не отказ витка).
    }
  })();

  stopping.set(root, promise);
  try {
    await promise;
  } finally {
    stopping.delete(root);
  }
}

/** Только для тестов — реестр иначе живёт всё время процесса Runner'а. */
export function _resetSandboxRegistryForTests(): void {
  active.clear();
  pending.clear();
  stopping.clear();
}

/** Только для тестов — регистрирует готовую ручку без похода в Docker, чтобы адресацию
 * `findSandboxForCwd` можно было проверить без живого демона. */
export function _setSandboxForTests(projectRoot: string, handle: SandboxHandle): void {
  active.set(normalize(projectRoot), handle);
}

/** Только для тестов — имитирует «остановка в процессе» без похода в Docker, чтобы
 * проверить, что `ensureSandboxFor` реально ждёт её, а не гонится мимо. */
export function _setStoppingForTests(projectRoot: string, promise: Promise<void>): void {
  stopping.set(normalize(projectRoot), promise);
}
