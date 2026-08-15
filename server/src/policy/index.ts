/**
 * Единственная точка, где принимается решение политики.
 *
 * Оба флоу исполнения (sdk и loop) зовут `evaluate` с уже нормализованным вызовом.
 * Копий этой логики нет ни у одного из них — именно это удерживает флоу от расхождения,
 * и именно это проверяет conformance-тест.
 */

import type { CallKind, NormalizedCall, PolicyContext, PolicyVerdict, ToolName } from '../types.ts';
import { POLICY_OK, policyDeny } from '../types.ts';
import * as denyList from './denyList.ts';
import * as pathScope from './pathScope.ts';
import * as planScope from './planScope.ts';

export { denyList, pathScope, planScope };
export * from './paths.ts';
export { redirectTargets } from './shellRedirects.ts';

const KIND_TO_TOOL: Record<CallKind, ToolName | null> = {
  read: 'Read',
  glob: 'Glob',
  grep: 'Grep',
  write: 'Write',
  edit: 'Edit',
  bash: 'Bash',
  ask_human: 'AskHuman',
  finalize_artifact: 'FinalizeArtifact',
  unknown: null,
};

/**
 * Права выдаются на шаг, а не на прогон: на каждом этапе доступен только тот набор
 * инструментов, который этап объявил. Незнакомый инструмент отклоняется — по худшему
 * случаю мы обязаны считать его записью.
 */
function checkStageTools(call: NormalizedCall, ctx: PolicyContext): PolicyVerdict {
  if (call.kind === 'unknown') {
    return policyDeny(
      'stageTools',
      `инструмент «${call.toolName}» не объявлен на этом этапе и не опознан рантаймом.`,
    );
  }
  const tool = KIND_TO_TOOL[call.kind];
  if (tool === null) return POLICY_OK;
  if (!ctx.allowedTools.includes(tool)) {
    return policyDeny(
      'stageTools',
      `инструмент «${tool}» не разрешён на этом этапе. Доступны: ${ctx.allowedTools.join(', ')}.`,
    );
  }
  return POLICY_OK;
}

/**
 * Порядок проверок значим: сперва «имел ли этап такое право вообще», затем безопасный пол,
 * затем границы проекта, и только потом план. Так сообщение об отказе называет самую
 * раннюю и самую понятную причину, а не последнюю сработавшую.
 */
export function evaluate(call: NormalizedCall, ctx: PolicyContext): PolicyVerdict {
  const checks: PolicyVerdict[] = [
    checkStageTools(call, ctx),
    denyList.check(call),
    pathScope.check(call, ctx),
    planScope.check(call, ctx),
  ];
  for (const v of checks) if (!v.ok) return v;
  return POLICY_OK;
}
