/**
 * Первый уровень confinement: «лежит ли путь внутри проекта».
 *
 * Порт `tools/PathScope.java`. Проверка лексическая и потому чистая; побеги через symlink
 * ловятся при исполнении инструмента, где уже есть доступ к диску.
 */

import type { NormalizedCall, PolicyContext, PolicyVerdict } from '../types.ts';
import { POLICY_OK, policyDeny } from '../types.ts';
import { relativizeWithin, resolveUserPath } from './paths.ts';

/** Путь относительно корня, либо verdict с отказом. */
export function within(ctx: PolicyContext, userPath: string): string | PolicyVerdict {
  const abs = resolveUserPath(ctx.projectRoot, userPath);
  const rel = relativizeWithin(ctx.projectRoot, abs);
  if (rel === null) {
    return policyDeny(
      'pathScope',
      `путь «${userPath}» ведёт за пределы проекта (${ctx.projectRoot}). ` +
        `Инструменты работают только внутри корня целевого проекта.`,
    );
  }
  return rel;
}

function checkPath(ctx: PolicyContext, userPath: string): PolicyVerdict {
  const r = within(ctx, userPath);
  return typeof r === 'string' ? POLICY_OK : r;
}

export function check(call: NormalizedCall, ctx: PolicyContext): PolicyVerdict {
  switch (call.kind) {
    case 'read':
    case 'write':
    case 'edit':
      return checkPath(ctx, call.path);
    case 'glob':
    case 'grep':
      return call.path === null ? POLICY_OK : checkPath(ctx, call.path);
    // Bash исполняется с cwd = корень проекта. Цели редиректов, уходящие наружу
    // (включая /dev/null и временные файлы), здесь намеренно не трогаем — модель
    // законно пишет во временные файлы, а отказ политики оператор снять не может.
    default:
      return POLICY_OK;
  }
}
