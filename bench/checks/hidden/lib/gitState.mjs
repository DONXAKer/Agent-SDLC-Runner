/**
 * Состояние git-дерева цели — для кейсов «правильный исход: НЕ трогать код».
 *
 * `already-done`, `broken-test`, `wrong-diagnosis` проверяют, что модель не изменила
 * файлы, которые менять не следовало. Рабочая копия витка — git-репозиторий
 * (`bench/src/workspace.ts` делает `git init` и ветку), пристинная фикстура в
 * `bench/fixtures/<family>` — нет. Кейсы на пристинной обязаны ПРОПУСКАТЬСЯ (`t.skip`), не
 * зеленеть и не краснеть: `bench/src/hiddenTests.ts` разбирает `# SKIP` и не считает их.
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

export function gitAvailable(target) {
  return existsSync(join(target, '.git'));
}

function git(target, args) {
  const r = spawnSync('git', args, { cwd: target, encoding: 'utf8', windowsHide: true });
  if (r.error !== undefined) throw r.error;
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} в ${target}: код ${r.status}\n${r.stderr}`);
  return r.stdout;
}

/**
 * Пути обязательны: без них `git status` видит всё дерево, а рабочая копия витка никогда не
 * чиста (untracked `.sdlc/<slug>/`, артефакты этапов) — кейс «не тронуто» краснел бы на
 * любом прогоне, включая идеальное решение.
 */
function requirePaths(paths, what) {
  if (!Array.isArray(paths) || paths.length === 0) {
    throw new Error(`${what}: нужен непустой список путей — дерево витка целиком «не тронутым» не бывает`);
  }
}

/** `git status --porcelain -- <paths>` цели; пустая строка — дерево по этим путям не тронуто (включая untracked). */
export function porcelain(target, paths) {
  requirePaths(paths, 'porcelain');
  return git(target, ['status', '--porcelain', '--', ...paths]).trim();
}

/** `git diff --stat HEAD -- <paths>`; пусто — отслеживаемые файлы по путям не менялись. Требует хотя бы одного коммита. */
export function diffStat(target, paths) {
  requirePaths(paths, 'diffStat');
  return git(target, ['diff', '--stat', 'HEAD', '--', ...paths]).trim();
}

/**
 * Пропускает кейс на цели без `.git` и возвращает `false`; иначе `true`. Вызывать первой
 * строкой кейса: `if (!skipUnlessGit(t, target)) return;`.
 */
export function skipUnlessGit(t, target) {
  if (gitAvailable(target)) return true;
  t.skip('цель без .git — нетронутость дерева проверяется только в рабочей копии витка');
  return false;
}
