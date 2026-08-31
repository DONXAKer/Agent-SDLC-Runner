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

import { isWindowsStyle, isWithinAny, pathsEqual, relativizeWithin, resolveUserPath } from './paths.ts';

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

/**
 * Путь, закрытый на чтение на этом этапе.
 *
 * Не «нижняя граница» и не границы проекта, а сужение чтения ради независимости
 * рецензента: файл лежит внутри проекта и доступен всем остальным этапам. Сравнение —
 * тем же `pathsEqual`, что и у защищённых от записи артефактов, чтобы «читать нельзя» и
 * «писать нельзя» не разошлись в понимании одного и того же пути.
 */
function isReadDenied(ctx: PolicyContext, rel: string): boolean {
  const ci = isWindowsStyle(ctx.projectRoot);
  return (ctx.readDenied ?? []).some((p) => pathsEqual(p, rel, ci));
}

function checkPath(ctx: PolicyContext, userPath: string, access: Access): PolicyVerdict {
  const r = within(ctx, userPath, access);
  if (typeof r !== 'string') return r;
  if (access === 'read' && isReadDenied(ctx, r)) {
    return policyDeny(
      'pathScope',
      `чтение «${r}» на этапе ${ctx.stage} закрыто: это отчёт другой попытки. ` +
        `Независимость ревью требует, чтобы находки предыдущей попытки не переезжали в ` +
        `эту; связь между попытками несут retry_instruction и carry_forward, которые ` +
        `подаёт машина витка.`,
    );
  }
  return POLICY_OK;
}

/**
 * Шаблон поиска, уводящий за пределы проекта.
 *
 * Разрешить `..` внутри шаблона нельзя — путь в нём не резолвится лексически (звёздочки
 * могут раскрыться во что угодно), поэтому единственная надёжная проверка — запретить
 * абсолютные шаблоны и восхождение вверх. Формы методологии читаются через `Read`, где
 * `readOnlyRoots` работает штатно, так что легальных случаев эта строгость не задевает.
 */
function checkSearchPattern(ctx: PolicyContext, pattern: string): PolicyVerdict | null {
  const p = pattern.replace(/\\/g, '/');
  const absolute = /^([A-Za-z]:\/|\/|\\\\)/.test(p);
  const ascends = p.split('/').includes('..');
  if (!absolute && !ascends) return null;

  return policyDeny(
    'pathScope',
    `шаблон поиска «${pattern}» ведёт за пределы проекта (${ctx.projectRoot}). ` +
      `Ищи относительным шаблоном внутри проекта; формы методологии читай инструментом Read.`,
  );
}

export function check(call: NormalizedCall, ctx: PolicyContext): PolicyVerdict {
  switch (call.kind) {
    case 'read':
      return checkPath(ctx, call.path, 'read');
    case 'write':
    case 'edit':
      return checkPath(ctx, call.path, 'write');
    case 'glob': {
      // Шаблон — тоже путь. Пока проверялось только необязательное поле `path`,
      // `Glob {pattern: "C:/Users/user/.claude/*.json"}` уходил наружу проекта, и следа
      // не оставалось даже в очереди одобрений: поиск в неё не ставится по дешевизне.
      const patternProblem = checkSearchPattern(ctx, call.pattern);
      if (patternProblem !== null) return patternProblem;
      return call.path === null ? POLICY_OK : checkPath(ctx, call.path, 'read');
    }
    case 'grep':
      // У `Grep` шаблон — это регулярное выражение по СОДЕРЖИМОМУ, а не путь, и мерить его
      // тем же предикатом нельзя: `\d+`, `\bimport\b`, `C:\\Users` внутри разбираемой
      // строки после замены `\` на `/` выглядят как абсолютный путь или восхождение вверх,
      // и обычный поиск получал отказ политики, снять который оператор не может. Каталог
      // поиска ограничивает поле `path` — оно и проверяется.
      return call.path === null ? POLICY_OK : checkPath(ctx, call.path, 'read');
    // Bash исполняется с cwd = корень проекта. Цели редиректов, уходящие наружу
    // (включая /dev/null и временные файлы), здесь намеренно не трогаем — модель
    // законно пишет во временные файлы, а отказ политики оператор снять не может.
    default:
      return POLICY_OK;
  }
}
