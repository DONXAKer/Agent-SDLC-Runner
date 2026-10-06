import { DECISION, readArtifact, readDecision } from '../../../artifacts/artifact.ts';
import { extractFilesToTouch } from '../../../artifacts/planFiles.ts';
import { planSteps } from '../../../artifacts/planSteps.ts';
import { isPreparationV2, preparationReviewProblem } from '../../../artifacts/preparation.ts';
import { buildRuntimeLocatorMap, fillVerifiedChunkLocation, validateLocatorMap } from '../../chunkLocatorApproval.ts';
import { approvedPlanDate } from '../../journalAutofill.ts';
import { planMapProblem } from '../plan.ts';
import type { StageHost, SeededArtifact } from '../types.ts';

export function reuseLocatorApproval(host: StageHost, agent: string, response: string, seeded: readonly SeededArtifact[]): string | null {
  if (agent !== 'sdlc-locator' || !isPreparationV2(host.paths)) return null;
  const plan = readArtifact(host.paths.plan);
  if (!plan.exists) return 'Одобренный plan.md не найден; подтверждение места правки не переиспользовано.';
  const reviewProblem = preparationReviewProblem(host.paths);
  if (reviewProblem !== null) return `Проработка изменилась или не одобрена (${reviewProblem}); подтверждение места правки не переиспользовано.`;
  const mapProblem = planMapProblem(host.ctx());
  if (mapProblem !== null) return `${mapProblem}; подтверждение места правки не переиспользовано.`;
  const plannedFiles = extractFilesToTouch(plan.text);
  const modelMap = validateLocatorMap(response, plannedFiles, host.paths.projectRoot);
  const runtimeMap = modelMap.ok ? null : buildRuntimeLocatorMap(plan.text, host.paths.projectRoot);
  if (!modelMap.ok) {
    host.emit({
      type: 'warning', runId: host.id, stage: 'chunk',
      message: runtimeMap === null
        ? `карта locator не подтверждена, резервная проверка дерева не удалась: ${modelMap.reason}`
        : `locator вернул непригодную карту (${modelMap.reason}); список путей и точные якоря восстановлены рантаймом из одобренного плана и дерева`,
    });
    if (runtimeMap === null) {
      return `Рантайм не подтвердил карту locator (${modelMap.reason}), и не смог безопасно построить её из одобренного плана и дерева. Поля журнала оставлены пустыми; не начинай реализацию.`;
    }
  }
  const verified = modelMap.ok ? modelMap : { ok: true as const, value: runtimeMap! };
  const steps = planSteps(plan.text);
  const normalizePath = (path: string): string => path.replace(/\\/gu, '/').replace(/^\.\//u, '').toLowerCase();
  const stepFiles = new Set(steps.map((step) => normalizePath(step.file)));
  if (steps.length === 0 || plannedFiles.some((path) => !stepFiles.has(normalizePath(path)))) {
    return 'JSON-карта совпала с files_to_touch, но план не содержит шага на каждый путь; подтверждение места правки не переиспользовано.';
  }
  const approvedOn = approvedPlanDate(plan.text);
  if (approvedOn === null || readDecision(plan.text, DECISION.approval).state !== 'granted') {
    return 'Дата одобрения плана не подтверждена; решение оператора для места правки не переиспользовано.';
  }
  const journalPath = host.paths.chunkJournal(host.chunk());
  const journal = readArtifact(journalPath);
  if (!journal.exists) return 'Журнал chunk не найден; подтверждение места правки не записано.';
  const points = steps.map((step) => `${step.file}:${step.symbol ?? (step.isNew ? 'new file' : 'file-level change')}`);
  const filled = fillVerifiedChunkLocation(journal.text, verified.value.files, approvedOn, points);
  if (filled === null) return 'Форма журнала отличается от проверенного шаблона; подтверждение места правки не записано.';
  host.writeAutofilled(journalPath, filled, [...seeded]);
  const message = modelMap.ok
    ? 'рантайм записал точки правки из карты locator, сверенной с планом и файлами'
    : 'рантайм сверил все цели одобренного плана и сам взял точные якоря из файлов после ошибки locator';
  host.emit({ type: 'warning', runId: host.id, stage: 'chunk', message });
  return modelMap.ok
    ? `Рантайм проверил полный JSON-ответ locator против одобренного plan.md и текущих исходников, записал карту и сослался на одобрение плана этой сессии (${approvedOn}). Не спрашивай человека повторно и не меняй эти поля; переходи к реализации в пределах files_to_touch.`
    : `Рантайм отклонил ответ locator, затем проверил каждый путь из одобренного files_to_touch, определил состояние по дереву и записал точные якоря из файлов; одобрение плана этой сессии (${approvedOn}) распространяется на эти подтверждённые цели. Не меняй поля журнала; переходи к реализации строго в пределах плана.`;

}
