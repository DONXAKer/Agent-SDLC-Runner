/**
 * Рабочая копия фикстуры на один прогон.
 *
 * Копия одноразовая и лежит в tmp. Из этого следует всё остальное: старт у всех моделей
 * побайтово одинаковый, ущерб от разрушающей перезаписи никуда не уезжает, а ветку витка
 * можно завести заранее — не подменяя собой проверку, которая эту ветку сторожит.
 */

import { cpSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { git } from '../../server/src/gates/git.ts';

export interface Workspace {
  /** Корень рабочей копии — он же `projectRoot` целевого проекта для раннера. */
  root: string;
  slug: string;
  branch: string;
  baseCommit: string;
  dispose(): void;
}

export class WorkspaceError extends Error {}

async function run(args: string[], cwd: string): Promise<string> {
  const r = await git(args, cwd);
  if (r.code !== 0) {
    throw new WorkspaceError(`git ${args.join(' ')} → код ${r.code}: ${r.stderr.trim() || r.stdout.trim()}`);
  }
  return r.stdout.trim();
}

export interface PrepareArgs {
  fixtureDir: string;
  slug: string;
  /** Ветка витка. Задача её называет, и она обязана совпасть с полем в intent.md. */
  branch: string;
}

/**
 * Разложить фикстуру в tmp и довести до состояния «виток может начаться».
 *
 * Имя и почта коммиттера ставятся ЛОКАЛЬНО в репозитории: на машине без глобального
 * `user.name` коммит падает, и падал бы он посреди подготовки, а не в понятном месте.
 */
export async function prepareWorkspace(args: PrepareArgs): Promise<Workspace> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'sdlc-bench-')));

  try {
    cpSync(args.fixtureDir, root, { recursive: true });

    await run(['init', '--initial-branch=main'], root);
    await run(['config', 'user.name', 'Бенчмарк'], root);
    await run(['config', 'user.email', 'bench@example.invalid'], root);
    // core.autocrlf на машине оператора может подменить перевод строки при добавлении в
    // индекс, и тогда diff попытки покажет весь файл изменённым. Фикстура фиксирует правило
    // сама, а не наследует настройку машины.
    await run(['config', 'core.autocrlf', 'false'], root);
    await run(['add', '-A'], root);
    await run(['commit', '-m', 'фикстура: исходное состояние'], root);

    const baseCommit = await run(['rev-parse', 'HEAD'], root);
    await run(['checkout', '-b', args.branch], root);

    return {
      root,
      slug: args.slug,
      branch: args.branch,
      baseCommit,
      dispose: () => rmSync(root, { recursive: true, force: true }),
    };
  } catch (e) {
    // Подготовка упала на полпути — оставлять недоделанную копию в %TEMP% незачем.
    rmSync(root, { recursive: true, force: true });
    throw e;
  }
}
