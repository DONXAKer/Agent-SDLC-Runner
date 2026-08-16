/**
 * Третий уровень confinement: «говорил ли план, что мы тронем этот файл».
 *
 * Порт `tools/PlanScope.java`. Существует потому, что агенты выходят за план очень
 * последовательно и всегда в одну сторону — файлов больше, никогда меньше. На одной живой
 * задаче наблюдалось: четыре markdown-отчёта в корне репозитория, jest config и дерево
 * `__tests__` вопреки прямому указанию, что тесты вне scope, и `.bak`-копии рядом с
 * правимым файлом.
 *
 * `scope_gate` ловит всё это, но двумя этапами позже, и лечится оно полной итерацией
 * заново. Отказ в момент записи превращает «вышел за план» из дефекта, который пайплайн
 * переживает, в действие, которого агент совершить не может.
 *
 * **Исключение для артефактов процесса сужено до каталога своего витка и не покрывает
 * решения человека.** Раньше из-под проверки выпадал весь `.sdlc/**`, а там лежат `plan.md`
 * и `gates.md`: агент на этапе chunk мог дописать себе `files_to_touch`, проставить строку
 * одобрения — и следующий этап читал уже расширенный план, потому что `Run` перечитывает
 * его с диска. Агент, который может переписать одобренный план, может и снять с себя любое
 * ограничение.
 */

import type { NormalizedCall, PolicyContext, PolicyVerdict } from '@sdlc-runner/shared';
import { POLICY_OK, policyDeny } from '@sdlc-runner/shared';

import {
  isWindowsStyle,
  normalizePlanPath,
  pathsEqual,
  relativizeWithin,
  resolveUserPath,
} from './paths.ts';
import { redirectTargets } from './shellRedirects.ts';

function denied(ctx: PolicyContext, userPath: string, why: string): PolicyVerdict {
  const planned = (ctx.planFiles ?? []).map((p) => `  ${p}`).join('\n');
  return policyDeny(
    'planScope',
    `запись отклонена: ${why}\n` +
      `Файлы плана:\n${planned}\n` +
      `Правь один из них. Если файл действительно относится к задаче, его сначала надо ` +
      `добавить в план — не создавай его побочным эффектом (отчёты о статусе, .bak-копии и ` +
      `тестовые леса это обычные нарушители, и здесь они не нужны никогда).`,
  );
}

/**
 * Артефакты текущего витка — их пишет сам виток, и в `files_to_touch` они по методологии
 * не попадают. Каталог чужого витка сюда не входит: рантайм не должен позволять агенту
 * витка A править артефакты витка B.
 */
function isOwnProcessArtifact(rel: string, ctx: PolicyContext): boolean {
  const ci = isWindowsStyle(ctx.projectRoot);
  const dir = `${ctx.sdlcDir}/`;
  return pathsEqual(rel.slice(0, dir.length), dir, ci);
}

function isProtected(rel: string, ctx: PolicyContext): boolean {
  const ci = isWindowsStyle(ctx.projectRoot);
  return ctx.protectedArtifacts.some((p) => pathsEqual(p, rel, ci));
}

function checkOnePath(ctx: PolicyContext, userPath: string): PolicyVerdict {
  const abs = resolveUserPath(ctx.projectRoot, userPath);
  const rel = relativizeWithin(ctx.projectRoot, abs);
  if (rel === null) return POLICY_OK; // вне проекта — дело PathScope, не наше

  if (isProtected(rel, ctx)) {
    return policyDeny(
      'planScope',
      `запись в «${rel}» отклонена: это решение человека или конфигурация процесса, ` +
        `а не рабочий файл витка. Агент, который может переписать одобренный план или ` +
        `набор гейтов, может снять с себя любое ограничение. Правку такого файла делает ` +
        `человек, либо она принадлежит другому этапу.`,
    );
  }

  if (isOwnProcessArtifact(rel, ctx)) return POLICY_OK;

  const allowed = ctx.planFiles ?? [];
  const ci = isWindowsStyle(ctx.projectRoot);
  for (const candidate of allowed) {
    if (pathsEqual(rel, normalizePlanPath(ctx.projectRoot, candidate), ci)) return POLICY_OK;
  }

  return denied(ctx, userPath, `«${userPath}» не входит в files_to_touch одобренного плана.`);
}

export function check(call: NormalizedCall, ctx: PolicyContext): PolicyVerdict {
  // Защищённые артефакты действуют всегда, даже до плана: одобрение, записанное на
  // этапе 4, не должно переживать правку на этапе 4 же.
  const planActive = ctx.planFiles !== null && ctx.planFiles.length > 0;

  switch (call.kind) {
    case 'write':
    case 'edit': {
      if (!planActive) {
        const rel = relativizeWithin(ctx.projectRoot, resolveUserPath(ctx.projectRoot, call.path));
        if (rel !== null && isProtected(rel, ctx)) return checkOnePath(ctx, call.path);
        return POLICY_OK;
      }
      return checkOnePath(ctx, call.path);
    }

    case 'bash': {
      // Закрыть только Write и Edit было мало: на стенде модель, которой прямым текстом
      // сказали не добавлять тестовые леса, произвела `tmp_test_runner.sh` через редирект.
      for (const target of redirectTargets(call.command)) {
        // О цели с неразвёрнутой переменной судить как о плановом файле нельзя: отказ
        // был бы обвинением, на которое модель не может ответить. Запрещённую категорию
        // в такой цели проверяет DenyList — он смотрит на текст, а не на план.
        if (target.unexpanded) continue;
        if (!planActive) {
          const rel = relativizeWithin(
            ctx.projectRoot,
            resolveUserPath(ctx.projectRoot, target.path),
          );
          if (rel === null || !isProtected(rel, ctx)) continue;
        }
        const v = checkOnePath(ctx, target.path);
        if (!v.ok) return v;
      }
      return POLICY_OK;
    }

    default:
      return POLICY_OK;
  }
}
