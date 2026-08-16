/**
 * Первый уровень confinement: «лежит ли путь внутри проекта».
 *
 * Порт `tools/PathScope.java`. Проверка лексическая и потому чистая; побеги через symlink
 * ловятся в гейте одобрений, где уже есть доступ к диску (`approval/symlink.ts`).
 *
 * Отдельная оговорка про чтение. Промпт этапа прямым текстом велит читать формы артефактов
 * из каталога методологии, а он лежит вне целевого проекта. Запрет на это ломал виток на
 * первом же шаге: модель сочиняла артефакт своими словами, а счётчик плейсхолдеров
 * показывал ноль, потому что `‹…›` бывают только у скопированного шаблона. Поэтому
 * каталоги форм и текстов этапов открыты — но **только на чтение**.
 */

import type { NormalizedCall, PolicyContext, PolicyVerdict } from '@sdlc-runner/shared';
import { POLICY_OK, policyDeny } from '@sdlc-runner/shared';

import { isWithinAny, relativizeWithin, resolveUserPath } from './paths.ts';

export type Access = 'read' | 'write';

/** Путь относительно корня, либо verdict с отказом. */
export function within(ctx: PolicyContext, userPath: string, access: Access): string | PolicyVerdict {
  const abs = resolveUserPath(ctx.projectRoot, userPath);
  const rel = relativizeWithin(ctx.projectRoot, abs);
  if (rel !== null) return rel;

  if (access === 'read' && isWithinAny(ctx.readOnlyRoots, abs)) return abs;

  const extra =
    access === 'read' && ctx.readOnlyRoots.length > 0
      ? ` На чтение дополнительно открыты: ${ctx.readOnlyRoots.join(', ')}.`
      : '';

  return policyDeny(
    'pathScope',
    `путь «${userPath}» ведёт за пределы проекта (${ctx.projectRoot}).${extra}`,
  );
}

function checkPath(ctx: PolicyContext, userPath: string, access: Access): PolicyVerdict {
  const r = within(ctx, userPath, access);
  return typeof r === 'string' ? POLICY_OK : r;
}

export function check(call: NormalizedCall, ctx: PolicyContext): PolicyVerdict {
  switch (call.kind) {
    case 'read':
      return checkPath(ctx, call.path, 'read');
    case 'write':
    case 'edit':
      return checkPath(ctx, call.path, 'write');
    case 'glob':
    case 'grep':
      return call.path === null ? POLICY_OK : checkPath(ctx, call.path, 'read');
    // Bash исполняется с cwd = корень проекта. Цели редиректов, уходящие наружу
    // (включая /dev/null и временные файлы), здесь намеренно не трогаем — модель
    // законно пишет во временные файлы, а отказ политики оператор снять не может.
    default:
      return POLICY_OK;
  }
}
