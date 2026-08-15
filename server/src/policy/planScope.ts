/**
 * Третий уровень confinement: «говорил ли план, что мы тронем этот файл».
 *
 * Порт `tools/PlanScope.java`. Существует потому, что агенты выходят за план очень
 * последовательно и всегда в одну сторону — файлов больше, никогда меньше. На одной живой
 * задаче наблюдалось: четыре markdown-отчёта в корне репозитория, jest config и дерево
 * `__tests__` вопреки прямому указанию, что тесты вне scope, и `.bak`-копии рядом с
 * правимым файлом. Ничего вредоносного — модель просто решила, что лишние артефакты
 * будут полезны.
 *
 * `scope_gate` ловит всё это, но двумя этапами позже, и лечится оно полной итерацией
 * заново. Отказ в момент записи превращает «вышел за план» из дефекта, который пайплайн
 * переживает, в действие, которого агент совершить не может, и сразу отдаёт ему ошибку,
 * на которую он способен отреагировать.
 *
 * Пустой allowlist (виток не дошёл до одобренного плана) отключает проверку.
 */

import type { NormalizedCall, PolicyContext, PolicyVerdict } from '../types.ts';
import { POLICY_OK, policyDeny } from '../types.ts';
import { normalizePlanPath, relativizeWithin, resolveUserPath } from './paths.ts';
import { redirectTargets } from './shellRedirects.ts';

function denied(ctx: PolicyContext, userPath: string): PolicyVerdict {
  const planned = (ctx.planFiles ?? []).map((p) => `  ${p}`).join('\n');
  return policyDeny(
    'planScope',
    `запись отклонена: «${userPath}» не входит в files_to_touch одобренного плана.\n` +
      `Файлы плана:\n${planned}\n` +
      `Правь один из них. Если файл действительно относится к задаче, его сначала надо ` +
      `добавить в план — не создавай его побочным эффектом (отчёты о статусе, .bak-копии и ` +
      `тестовые леса это обычные нарушители, и здесь они не нужны никогда).`,
  );
}

/**
 * Артефакты процесса исключены из сверки: их пишет сам виток.
 * Методология требует того же и от scope-гейта — пути `.sdlc/**` в files_to_touch
 * не пишутся и в сверке не участвуют.
 */
function isProcessArtifact(rel: string): boolean {
  return rel === '.sdlc' || rel.startsWith('.sdlc/');
}

function checkOnePath(ctx: PolicyContext, userPath: string): PolicyVerdict {
  const abs = resolveUserPath(ctx.projectRoot, userPath);
  const rel = relativizeWithin(ctx.projectRoot, abs);
  if (rel === null) return POLICY_OK; // вне проекта — дело PathScope, не наше
  if (isProcessArtifact(rel)) return POLICY_OK;

  const allowed = ctx.planFiles ?? [];
  for (const candidate of allowed) {
    if (rel === normalizePlanPath(ctx.projectRoot, candidate)) return POLICY_OK;
  }
  return denied(ctx, userPath);
}

export function check(call: NormalizedCall, ctx: PolicyContext): PolicyVerdict {
  const allowed = ctx.planFiles;
  if (allowed === null || allowed.length === 0) return POLICY_OK;

  switch (call.kind) {
    case 'write':
    case 'edit':
      return checkOnePath(ctx, call.path);

    case 'bash': {
      // Закрыть только Write и Edit было мало: на стенде модель, которой прямым текстом
      // сказали не добавлять тестовые леса, произвела `tmp_test_runner.sh` через редирект.
      for (const target of redirectTargets(call.command)) {
        const v = checkOnePath(ctx, target);
        if (!v.ok) return v;
      }
      return POLICY_OK;
    }

    default:
      return POLICY_OK;
  }
}
