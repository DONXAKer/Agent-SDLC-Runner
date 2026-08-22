/** Снимок и восстановление переменных окружения — тесты не должны утекать друг в друга. */

/** Одна переменная. */
export function withEnv(key: string, value: string | undefined, run: () => void): void {
  const prev = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
  try {
    run();
  } finally {
    if (prev === undefined) delete process.env[key];
    else process.env[key] = prev;
  }
}

/** То же самое, но для асинхронного тела — синхронный `withEnv` восстановил бы env ДО
 *  завершения асинхронной операции внутри, а не после нее. */
export async function withEnvAsync(
  key: string,
  value: string | undefined,
  run: () => Promise<void>,
): Promise<void> {
  const prev = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
  try {
    await run();
  } finally {
    if (prev === undefined) delete process.env[key];
    else process.env[key] = prev;
  }
}

/** Несколько переменных разом — там, где `before`/`after` пришлось бы городить вручную. */
export function withEnvAll(vars: Record<string, string | undefined>, run: () => void): void {
  const prev = new Map(Object.keys(vars).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    run();
  } finally {
    for (const [k, v] of prev) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}
