/**
 * Гейт «Тесты красные на базе» — порт `base-check.py` методологии.
 *
 * На чистое дерево базы (`git worktree` на `base_sha`) накладываются только hunk'и тестовых
 * файлов патча попытки, и команда «Тесты» прогоняется дважды: до и после. `✅`, если тестовые
 * hunk'и дали НОВЫЕ падения относительно чистой базы — тесты попытки действительно требуют
 * правки кода; `❌`, если новых падений нет — новые/изменённые тесты зелёные ДО правки и не
 * доказывают пункты, которые закрывают. Тестовых файлов в патче нет — `⏭`; инструмент
 * тестов отсутствует — `⏭` с уликой инструмента (никогда `✅`). Побочно называет чужие
 * падающие тесты базы: красное на чистой базе — не регрессия chunk'а.
 */

import { existsSync, mkdtempSync, rmSync, rmdirSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { testOnlyPatch } from '../../diff/testPath.ts';
import { findSandboxForCwd } from '../../sandbox/registry.ts';
import { git, hasCommits, isRepo } from '../git.ts';
import { missingTool } from '../missingTool.ts';
import { runShell } from '../shell.ts';
import { attemptPatchOf } from './attemptPatch.ts';
import { fullOutputOf, outputTailOf } from './output.ts';
import type { BuiltinGate, BuiltinOutcome } from './index.ts';

const FAIL_LINE =
  /^(?:FAILED|ERROR)\s+(\S+)|^(?:FAIL|ERROR):\s+(\S+(?:\s+\([^)]+\))?)|^\s*(?:✕|×|✘)\s+(.+)$|^(\S+(?:\s*>\s*\S+)*)\s+FAILED\b|^\s*\[(?:FAIL|ERROR)\]\s+(.+)$|^--- FAIL:\s+(\S+)/;

/** Идентификаторы упавших тестов по строкам вывода известных раннеров. */
export function failuresOf(output: string): Set<string> {
  const ids = new Set<string>();
  for (const line of output.split(/\r?\n/)) {
    const m = FAIL_LINE.exec(line);
    if (m === null) continue;
    const ident = (m.slice(1).find((g) => g !== undefined && g !== '') ?? '').trim();
    // «FAILED (failures=1)» — итог раннера, не тест.
    if (ident !== '' && !ident.startsWith('(')) ids.add(ident);
  }
  return ids;
}

function failWords(output: string): number {
  return (output.match(/\b(FAIL|FAILED|ERROR)\b/g) ?? []).length;
}

/** Каталоги зависимостей, которые в worktree не попадают, а тестам нужны. */
const DEPS_DIRS = ['node_modules', '.venv', 'venv', 'vendor'];

export const baseCheckGate: BuiltinGate = async (ctx): Promise<BuiltinOutcome> => {
  const skip = (lastLine: string, extra: Partial<BuiltinOutcome> = {}): BuiltinOutcome => ({
    status: '⏭',
    command: ctx.testsCommand ?? null,
    exitCode: null,
    lastLine,
    ...extra,
  });
  if (!(await isRepo(ctx.projectRoot)) || !(await hasCommits(ctx.projectRoot))) {
    return skip('не git-репозиторий или нет коммитов — базы для прогона нет');
  }
  const base = ctx.baseSha ?? null;
  if (base === null) return skip('база diff\'а (поле «База» плана) не известна — worktree на базе не построить');
  const testsCmd = ctx.testsCommand ?? null;
  if (testsCmd === null) return skip('в наборе нет команды «Тесты» в обратных кавычках — на базе прогонять нечем');
  // Docker-песочница смонтирована на корень проекта: временный worktree вне его туда не
  // попадает, а гонять команду проекта на хосте мимо песочницы — обещать изоляцию, которой нет.
  if (findSandboxForCwd(ctx.projectRoot)?.exec.kind === 'docker') {
    return skip('docker-песочница проекта не покрывает временный worktree базы — гейт пропущен');
  }

  let patch: string;
  try {
    patch = await attemptPatchOf(ctx);
  } catch (e) {
    return skip(`патч попытки не снят: ${(e as Error).message}`);
  }
  const testsPatch = testOnlyPatch(patch);
  // Без тестовых hunk'ов проверять нечего — и worktree с двумя прогонами сьюта ради
  // приписки о красной базе не строится (ревью: цена гейта на каждом verify без тестов).
  if (testsPatch.trim() === '') return skip('в патче нет тестовых файлов — гейту нечего проверять');

  const tmp = mkdtempSync(join(tmpdir(), 'sdlc-base-'));
  const wt = join(tmp, 'base');
  const add = await git(['worktree', 'add', '--detach', wt, base], ctx.projectRoot, ctx.signal);
  if (add.code !== 0) {
    try {
      rmSync(tmp, { recursive: true, force: true });
    } catch {
      /* временный каталог доберёт ОС */
    }
    // Не среда: невалидная база (rebase после плана), `index.lock`, занятый путь — дефект
    // витка или состояния репозитория, чинится не другой машиной (ревью).
    return skip(`worktree на базе не создан — проверить нечем: ${add.stderr.trim().slice(0, 200)}`);
  }
  /** Ссылки на зависимости, которые ставили мы: снимаются ДО `git worktree remove`. */
  const links: string[] = [];
  try {
    // Зависимости в worktree не приезжают (они не в git): подвязываем каталоги проекта
    // ссылкой — junction на Windows не требует прав. Не вышло — тесты скажут сами.
    for (const d of DEPS_DIRS) {
      const src = join(ctx.projectRoot, d);
      const link = join(wt, d);
      if (existsSync(src) && !existsSync(link)) {
        try {
          symlinkSync(src, link, process.platform === 'win32' ? 'junction' : 'dir');
          links.push(link);
        } catch {
          /* тесты назовут отсутствие зависимостей сами */
        }
      }
    }
    const shell = { cwd: wt, timeoutMs: ctx.timeoutMs, ...(ctx.signal === undefined ? {} : { signal: ctx.signal }) };
    const clean = await runShell(testsCmd, shell);
    if (clean.denied !== null) return skip(`команда «Тесты» отклонена: ${clean.denied}`);
    if (clean.timedOut) return skip(`тесты на чистой базе не уложились в ${ctx.timeoutMs} мс — проверить нечем`);
    const cleanOut = fullOutputOf(clean.stdout, clean.stderr);
    const tool = missingTool(cleanOut, testsCmd, clean.exitCode);
    if (tool !== null) {
      return skip(`инструмент тестов отсутствует в среде — исполнить нечем: ${tool}`, { envBlocked: true, missingTool: tool });
    }
    const cleanFails = failuresOf(cleanOut);
    const baseNote =
      cleanFails.size === 0 ? '' : ` · на чистой базе уже красные (${cleanFails.size}): чужие падающие тесты, не регрессия chunk'а`;

    const patchPath = join(tmp, 'tests.patch');
    writeFileSync(patchPath, Buffer.from(testsPatch, 'utf8'));
    let applied = await git(['apply', '--3way', patchPath], wt, ctx.signal);
    if (applied.code !== 0) applied = await git(['apply', patchPath], wt, ctx.signal);
    if (applied.code !== 0) {
      return skip(`тестовые hunk'и не легли на базу — проверить нечем: ${applied.stderr.trim().slice(0, 200)}`);
    }
    const withTests = await runShell(testsCmd, shell);
    if (withTests.timedOut) return skip(`тесты с hunk'ами попытки на базе не уложились в ${ctx.timeoutMs} мс — проверить нечем`);
    const testsOut = fullOutputOf(withTests.stdout, withTests.stderr);
    const newFailures = [...failuresOf(testsOut)].filter((f) => !cleanFails.has(f)).sort();
    const red =
      withTests.exitCode !== 0 &&
      (clean.exitCode === 0 || newFailures.length > 0 || failWords(testsOut) > failWords(cleanOut));
    if (red) {
      return {
        status: '✅',
        command: testsCmd,
        exitCode: withTests.exitCode,
        lastLine: `тесты попытки красные на базе — правка кода им нужна${baseNote}`,
        evidence: newFailures.length > 0 ? newFailures : [`код возврата тестов на базе с тестовыми hunk'ами: ${withTests.exitCode}`],
        outputTail: outputTailOf(withTests.stdout, withTests.stderr),
      };
    }
    return {
      status: '❌',
      command: testsCmd,
      exitCode: withTests.exitCode,
      lastLine: `новые/изменённые тесты проходят ДО правки кода — они не доказывают пункты, которые закрывают${baseNote}`,
      evidence: ['тестовые hunk\'и патча не дали новых падений на базе без правок кода'],
      outputTail: outputTailOf(withTests.stdout, withTests.stderr),
    };
  } finally {
    // Ссылки снимаются САМИ и ДО `git worktree remove --force`: Git for Windows считает
    // junction обычным каталогом и удаляет его СОДЕРЖИМОЕ — реальный `node_modules`
    // проекта (ревью, подтверждено пробой). `rmdirSync`/`unlinkSync` на ссылке снимают
    // только саму ссылку, не цель.
    for (const link of links) {
      try {
        rmdirSync(link);
      } catch {
        try {
          unlinkSync(link);
        } catch {
          /* ссылки уже нет */
        }
      }
    }
    await git(['worktree', 'remove', '--force', wt], ctx.projectRoot);
    await git(['worktree', 'prune'], ctx.projectRoot);
    try {
      rmSync(tmp, { recursive: true, force: true });
    } catch {
      /* Windows: недобитый раннер держит файлы — временный каталог доберёт ОС, исход гейта важнее */
    }
  }
};
