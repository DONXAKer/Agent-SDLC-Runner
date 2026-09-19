/**
 * Локальный коммит этапа 7 — рантаймом, не моделью (`SDLC.md` → этап 7: «Делаю: локальный
 * коммит, передача контекста, публикация»). Коммит дёшево обратим («человек стоит здесь по
 * обратимости, а не по важности»), и решение о нём не выделено в отдельный гейт человека —
 * оно идёт ТЕМ ЖЕ путём, что любая запись модели (`host.requestApproval`): оператор видит
 * состав коммита в очереди одобрений так же, как увидел бы `Bash`-вызов модели, и его правка
 * («редактировать аргументы») исполняется дословно — тем же приёмом, что `plan.ts`/
 * `verify/records.ts` применяют `decision.updatedInput` к записи модели. До этой правки
 * (ревью code-review-all, 2026-09-18) редактирование в очереди одобрений визуально
 * принималось, а исполнялся исходно вычисленный состав — правка оператора никуда не шла.
 *
 * Состав коммита — пересечение изменённого дерева с `files_to_touch` одобренного плана и
 * всем каталогом `.sdlc/<slug>/` витка (журналы, отчёты, планы — сопровождение работы, а
 * не только код). Файл вне этого пересечения в коммит не идёт: право коммитить не шире
 * права писать, которое уже выдал план. Сравнение путей — той же парой `normalizePlanPath`/
 * `pathsEqual`, что уже использует `policy/planScope.ts` для точно того же вопроса «тот же
 * ли это путь плана» — второй, рукописный способ сравнения путей расходился бы с ней на
 * первом же случае регистра или разделителя на Windows (тоже найдено ревью).
 *
 * Исполнение — через `runShell`, тот же путь, что у любой одобренной команды `Bash`: команда,
 * которую видел и одобрил (или поправил) оператор, — это и есть команда, которая исполнится,
 * без второго, параллельного способа запуска. Прежняя версия строила текст превью склейкой
 * через пробел, а исполняла отдельными `git()`-вызовами с массивом аргументов — при пути с
 * пробелом превью и исполнение расходились (тоже найдено ревью); теперь путь ровно один.
 *
 * **Известный, осознанно не закрытый пробел** (ревью code-review-all, 2026-09-18): синтетический
 * `NormalizedCall` для `host.requestApproval` — это `git add -- <targets> && git commit -m
 * <msg>`, готовая shell-команда без файловых редиректов. `pathScope`/`planScope` в
 * `checkAll` разбирают именно редиректы записи (`shellRedirects.ts`) — у команды их нет, и
 * эти два слоя пропускают её независимо от состава `targets`. Гарантия «коммитим только то,
 * что план разрешил писать» держится целиком на корректности `commitTargets` (её и покрывают
 * тесты), а не на политике. Закрыть эту дыру в политике значило бы либо дублировать разбор
 * состава `git add` рядом с разбором редиректов, либо учить `pathScope`/`planScope` отдельному
 * случаю ровно для одного рантаймового вызова — обе цены сочтены выше, чем у уже
 * протестированной чистой функции; если появится второй рантаймовый bash-вызов с тем же
 * профилем риска, разбор стоит вынести в политику одним местом, а не патчить точечно.
 */

import type { NormalizedCall } from '@sdlc-runner/shared';

import { readArtifact } from '../artifacts/artifact.ts';
import { extractFilesToTouch } from '../artifacts/planFiles.ts';
import { runShell } from '../gates/shell.ts';
import { changedPaths, git, isRepo } from '../gates/git.ts';
import { isWindowsStyle, normalizePlanPath, pathsEqual } from '../policy/paths.ts';
import type { StageHost } from './stages/types.ts';

/** Пересечение изменённого дерева с планом и каталогом витка — чистая функция, легко тестируется. */
export function commitTargets(
  changed: readonly string[],
  planFiles: readonly string[],
  sdlcPrefix: string,
  projectRoot: string,
): string[] {
  const ci = isWindowsStyle(projectRoot);
  const plan = planFiles.map((p) => normalizePlanPath(projectRoot, p));
  return changed.filter((raw) => {
    const p = normalizePlanPath(projectRoot, raw);
    return plan.some((candidate) => pathsEqual(p, candidate, ci)) || p.startsWith(sdlcPrefix);
  });
}

export function commitMessageFor(
  slug: string,
  chunk: number,
  attempt: number,
  verdict: 'passed' | 'aborted',
): string {
  return `sdlc(${slug}): chunk ${chunk} попытка ${attempt} — ${verdict === 'passed' ? 'приёмка' : 'обрыв витка'}`;
}

/**
 * Экранирование под двойные кавычки для POSIX shell (`sh -c`). Внутри двойных кавычек POSIX
 * shell по-прежнему раскрывает подстановку команды (`$(…)`, `` `…` ``) и сам бэкслеш —
 * экранирование этих символов (в этом порядке: сперва `\`, иначе следующие замены задвоятся)
 * снимает именно её, единственный здесь вектор, где имя файла исполнило бы произвольную
 * команду. `pathScope`/`symlinkEscape` проверяют выход пути ЗА каталог проекта, а не
 * содержимое имени — файл `$(rm -rf ~).ts` внутри `files_to_touch` эту проверку проходит
 * (найдено ревью code-review-all, 2026-09-19; до этой правки экранировались только `"`).
 */
export function posixShellQuote(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/`/g, '\\`').replace(/\$/g, '\\$')}"`;
}

/**
 * `cmd.exe` (Windows `spawn(..., { shell: true })` зовёт именно его) бэкслеш как
 * escape-символ не понимает: экранирование `posixShellQuote` добавило бы в имя файла лишний
 * символ и сломало бы честный путь. Здесь остаётся прежняя, ЧАСТИЧНАЯ защита (только `"`,
 * которую NTFS и так запрещает в имени файла) — тот же класс решения, что уже задокументирован
 * выше как известный пробел: `%VAR%`-подстановка cmd.exe у одной строки `sh -c`/`cmd /c`
 * бесследно не гасится ни одним экранированием без отказа от `shell: true`, а худший случай
 * на Windows уже — не выполнение произвольной команды (`$()`/`` ` `` — POSIX-only), а чтение
 * значения переменной окружения в текст коммита.
 */
function shellQuote(value: string): string {
  return process.platform === 'win32' ? `"${value.replace(/"/g, '\\"')}"` : posixShellQuote(value);
}

export interface CommitOutcome {
  committed: boolean;
  /** sha свежего коммита; `null` — коммита не было (нечего коммитить, отказ, ошибка git). */
  sha: string | null;
  note: string;
}

export async function commitByRuntime(host: StageHost, verdict: 'passed' | 'aborted'): Promise<CommitOutcome> {
  if (!(await isRepo(host.projectRoot))) return { committed: false, sha: null, note: 'не git-репозиторий' };

  const plan = readArtifact(host.paths.plan);
  const planFiles = plan.exists ? extractFilesToTouch(plan.text) : [];
  const sdlcPrefix = `.sdlc/${host.slug}/`;
  const changed = await changedPaths(host.projectRoot);
  const targets = commitTargets(changed, planFiles, sdlcPrefix, host.projectRoot);
  if (targets.length === 0) {
    return { committed: false, sha: null, note: 'нечего коммитить — изменений вне плана и .sdlc не найдено' };
  }

  const message = commitMessageFor(host.slug, host.chunk(), host.attempt(), verdict);
  const command = `git add -- ${targets.map(shellQuote).join(' ')} && git commit -m ${shellQuote(message)}`;
  const call: NormalizedCall = { kind: 'bash', command };
  const decision = await host.requestApproval({
    runId: host.id,
    stage: 'handoff',
    requestId: host.syntheticRequestId('commit'),
    toolName: 'Bash',
    rawInput: { command },
    call,
    ctx: host.policyContext('handoff'),
  });
  if (!decision.allowed) {
    return { committed: false, sha: null, note: `коммит отклонён: ${decision.reason ?? 'без причины'}` };
  }

  // Правка оператора («редактировать аргументы») применяется дословно: исполняется РОВНО
  // то, что вернул гейт одобрения, а не то, что было предложено рантаймом изначально —
  // тот же приём, что `plan.ts::fillPlanAxes`/`verify/records.ts::applyRecords` уже
  // применяют к `decision.updatedInput` записей модели.
  const updated = decision.updatedInput as Record<string, unknown> | null;
  const effectiveCommand = typeof updated?.['command'] === 'string' ? updated['command'] : command;

  const signal = host.aborterSignal();
  const result = await runShell(effectiveCommand, {
    cwd: host.projectRoot,
    timeoutMs: host.limits().gateTimeoutMs,
    ...(signal === undefined ? {} : { signal }),
  });
  if (result.exitCode !== 0) {
    return { committed: false, sha: null, note: `команда не удалась: ${result.lastLine || `код ${result.exitCode}`}` };
  }
  const sha = await git(['rev-parse', 'HEAD'], host.projectRoot);
  const note =
    effectiveCommand === command
      ? `закоммичено ${targets.length} файл(ов)`
      : 'закоммичено (состав правлен оператором)';
  return { committed: true, sha: sha.stdout.trim() || null, note };
}
