/**
 * Единственная точка, где принимается решение политики.
 *
 * Оба флоу исполнения (sdk и loop) зовут `evaluate` с уже нормализованным вызовом.
 * Копий этой логики нет ни у одного из них — именно это удерживает флоу от расхождения,
 * и именно это проверяет conformance-тест.
 *
 * Реэкспортов отсюда нет намеренно: «единственная точка решения», через которую заодно
 * тянут утилиты путей и лексер, перестаёт быть точкой. Кому нужен подмодуль — импортирует
 * его прямо.
 */

import type {
  CallKind,
  NormalizedCall,
  PolicyContext,
  PolicyVerdict,
  ToolName,
} from '@sdlc-runner/shared';
import { POLICY_OK, policyDeny } from '@sdlc-runner/shared';

import * as denyList from './denyList.ts';
import * as pathScope from './pathScope.ts';
import * as planScope from './planScope.ts';
import { redirectTargets } from './shellRedirects.ts';

const KIND_TO_TOOL: Record<CallKind, ToolName | null> = {
  read: 'Read',
  glob: 'Glob',
  grep: 'Grep',
  write: 'Write',
  edit: 'Edit',
  bash: 'Bash',
  ask_human: 'AskHuman',
  finalize_artifact: 'FinalizeArtifact',
  subagent: 'Task',
  request_scope_extension: 'RequestScopeExtension',
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
      `инструмент «${call.toolName}» не объявлен на этапе ${ctx.stage} и не опознан рантаймом.`,
    );
  }
  const tool = KIND_TO_TOOL[call.kind];
  if (tool === null) return POLICY_OK;
  if (!ctx.allowedTools.includes(tool)) {
    return policyDeny(
      'stageTools',
      `инструмент «${tool}» не разрешён на этапе ${ctx.stage}. Доступны: ${ctx.allowedTools.join(', ')}.`,
    );
  }
  return POLICY_OK;
}

/**
 * Порядок проверок значим: сперва «имел ли этап такое право вообще», затем безопасный пол,
 * затем границы проекта, и только потом план. Так сообщение об отказе называет самую
 * раннюю и самую понятную причину, а не последнюю сработавшую.
 *
 * Проверки ленивые: считать все четыре, чтобы взять первую неуспешную, значит гонять
 * лексер по команде, которую этап и так не имел права выполнять.
 */
export function evaluate(call: NormalizedCall, ctx: PolicyContext): PolicyVerdict {
  const checks = [
    (): PolicyVerdict => checkStageTools(call, ctx),
    (): PolicyVerdict => denyList.check(call),
    (): PolicyVerdict => pathScope.check(call, ctx),
    (): PolicyVerdict => planScope.check(call, ctx),
  ];
  for (const run of checks) {
    const v = run();
    if (!v.ok) return v;
  }
  return POLICY_OK;
}

/**
 * Во что запишет вызов — ПУТИ, без пояснений для человека.
 *
 * Это то, что скармливают проверкам: канонизации, сверке с планом, детекту побега через
 * symlink. Отдельная функция от `writeTargetsOf` не ради вкуса — та подмешивает в строку
 * «(переменная не развёрнута)», и путь с этим хвостом на диске не находится: `symlinkEscape`
 * получал несуществующий файл, не видел симлинка и пропускал ровно тот случай, ради
 * которого проверка написана.
 */
export function writeTargetPaths(call: NormalizedCall): string[] | null {
  switch (call.kind) {
    case 'write':
    case 'edit':
      return [call.path];
    case 'bash':
      return redirectTargets(call.command).map((t) => t.path);
    default:
      return null;
  }
}

/**
 * Во что запишет вызов — для панели одобрений. Оператор, одобряющий команду, должен
 * видеть её цели записи; заявленного поля на самом вызове для этого нет намеренно, чтобы
 * никто не принял незаполненный массив за посчитанный ответ.
 */
export function writeTargetsOf(call: NormalizedCall): string[] | null {
  switch (call.kind) {
    case 'write':
    case 'edit':
      return [call.path];
    case 'bash': {
      const targets = redirectTargets(call.command);
      return targets.length === 0
        ? []
        : targets.map((t) => (t.unexpanded ? `${t.path} (переменная не развёрнута)` : t.path));
    }
    default:
      return null;
  }
}
