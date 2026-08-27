/**
 * Pre-flight: не пускает этап 6 стартовать в среде, которая заведомо не пройдёт «Сборку»/
 * «Тесты».
 *
 * Раньше несоответствие среды обнаруживалось ТОЛЬКО прогоном самих гейтов — то есть после
 * того, как чек-аут, разведка и запись отчёта уже съели попытку и время оператора.
 * AUTH-104 сжёг так все три попытки подряд на одном и том же «java: not found». Проверка
 * здесь — до `stage_started`, до инкремента попытки (`Run.nextAttempt()` — отдельный метод,
 * этим кодом не вызывается): виток не стартует, но и попытку не тратит, ровно то же
 * намерение, что стоит за исходом `blocked_env` из плана ретроспективы (методология).
 *
 * Только для `verify`: именно там `.sdlc/gates.md` реально исполняется через `runShell`.
 * `chunk` тоже гоняет Bash самой моделью, но во флоу `sdk` эти вызовы идут мимо
 * `runShell` (встроенный инструмент SDK) — блокировать `chunk` по пробам песочницы значило
 * бы обещать защиту, которой для этого этапа пока нет (см. план, A1-b).
 */

import { ensureSandboxFor } from './registry.ts';
import { loadSandboxSpec } from './spec.ts';

export async function preflightBlockers(projectRoot: string, projectName: string): Promise<string[]> {
  if (loadSandboxSpec(projectRoot) === null) return [];

  let handle;
  try {
    handle = await ensureSandboxFor(projectRoot, projectName);
  } catch (e) {
    return [
      `песочница проекта (${projectRoot}/.sdlc/sandbox.json) не поднялась: ${(e as Error).message}. ` +
        `Гейты «Сборка»/«Тесты» в таком виде заведомо провалятся тем же классом ошибки, что и без ` +
        `песочницы вовсе — этап не начинается, попытка не тратится. Проверь Docker на хосте Runner'а ` +
        `и содержимое sandbox.json.`,
    ];
  }
  if (handle === null) return [];

  const probes = await handle.runProbes();
  const failed = probes.filter((p) => !p.ok);
  if (failed.length === 0) return [];

  return failed.map(
    (p) =>
      `проба среды провалилась: «${p.cmd}» — ${p.output.split('\n')[0] || '(пусто)'}. ` +
      `Песочница проекта не соответствует своей же спеке (${projectRoot}/.sdlc/sandbox.json) — ` +
      `этап не начинается, попытка не тратится.`,
  );
}
