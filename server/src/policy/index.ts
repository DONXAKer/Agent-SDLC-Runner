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
import { allowedHint, mcpPaths, modeOf } from './mcp.ts';
import * as pathScope from './pathScope.ts';
import * as planScope from './planScope.ts';
import { redirectTargets } from './shellRedirects.ts';

/**
 * `null` здесь означает разное, и это важно не перепутать: у `unknown` — «инструмент не
 * опознан, отказать по худшему случаю», у `mcp` — «право зависит от конкретного инструмента
 * внешнего сервера, а не от вида вызова». Оба разбираются в `checkStageTools` до таблицы.
 */
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
  record_claim: 'RecordClaim',
  record_finding: 'RecordFinding',
  mcp: null,
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
  if (call.kind === 'mcp') return checkMcp(call, ctx);
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
 * Права на конкретный инструмент внешнего MCP-сервера.
 *
 * Две различимые причины отказа, обе под именем `stageTools`: новой политики здесь не
 * заводится — это тот же вопрос «имел ли этап такое право», только имя инструмента приходит
 * не из закрытого union'а, а из разрешительного списка оператора.
 */
function checkMcp(
  call: Extract<NormalizedCall, { kind: 'mcp' }>,
  ctx: PolicyContext,
): PolicyVerdict {
  const mode = modeOf(call, ctx);
  if (mode === null) {
    return policyDeny(
      'stageTools',
      `инструмент «${call.tool}» сервера «${call.server}» не в разрешительном списке на ` +
        `этапе ${ctx.stage}. Разрешены: ${allowedHint(call.server, ctx)}.`,
    );
  }

  const tool: ToolName = mode === 'read' ? 'McpRead' : 'McpWrite';
  if (!ctx.allowedTools.includes(tool)) {
    const what = mode === 'read' ? 'читающие' : 'изменяющие';
    return policyDeny(
      'stageTools',
      `${what} вызовы MCP не разрешены вызывающему на этапе ${ctx.stage}. ` +
        `Доступны: ${ctx.allowedTools.join(', ')}.`,
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
  const stage = checkStageTools(call, ctx);
  if (!stage.ok) return stage;

  // MCP не описывается ни путём, ни shell-командой: три оставшиеся проверки идут по
  // объявленным аргументам-путям, а не по вызову целиком.
  if (call.kind === 'mcp') return evaluateMcpPaths(call, ctx);

  const checks = [
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
 * Три оставшиеся проверки для MCP-вызова — через подстановку файловых вызовов.
 *
 * Проверять нечего, кроме объявленных человеком аргументов-путей, а для них уже написаны
 * `denyList`, `pathScope` и `planScope`. Подставляем `read`/`write` с тем же путём и зовём
 * их как есть — вместо трёх новых веток, каждая из которых повторяла бы чужую логику и
 * расходилась бы с ней по одной. Порядок причин сохраняется тот же.
 *
 * Записи проверяются раньше чтений: отказ по записи и понятнее, и опаснее.
 */
function evaluateMcpPaths(
  call: Extract<NormalizedCall, { kind: 'mcp' }>,
  ctx: PolicyContext,
): PolicyVerdict {
  const asWrite = mcpPaths(call, ctx, 'write').map(
    (path): NormalizedCall => ({ kind: 'write', path, content: '' }),
  );
  const asRead = mcpPaths(call, ctx, 'read').map(
    (path): NormalizedCall => ({ kind: 'read', path, range: null }),
  );

  for (const synthetic of [...asWrite, ...asRead]) {
    for (const run of [
      (): PolicyVerdict => denyList.check(synthetic),
      (): PolicyVerdict => pathScope.check(synthetic, ctx),
      (): PolicyVerdict => planScope.check(synthetic, ctx),
    ]) {
      const v = run();
      if (!v.ok) return v;
    }
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
export function writeTargetPaths(call: NormalizedCall, ctx: PolicyContext): string[] | null {
  switch (call.kind) {
    case 'write':
    case 'edit':
      return [call.path];
    case 'bash':
      return redirectTargets(call.command).map((t) => t.path);
    case 'mcp': {
      // Пустой массив здесь означал бы «посчитано: не пишет никуда», а для `delete_asset`
      // это ложь: он пишет в дерево проекта, просто не файлом, имя которого мы знаем.
      const paths = mcpPaths(call, ctx, 'write');
      return paths.length === 0 ? null : paths;
    }
    default:
      return null;
  }
}

/**
 * Во что запишет вызов — для панели одобрений. Оператор, одобряющий команду, должен
 * видеть её цели записи; заявленного поля на самом вызове для этого нет намеренно, чтобы
 * никто не принял незаполненный массив за посчитанный ответ.
 */
export function writeTargetsOf(call: NormalizedCall, ctx: PolicyContext): string[] | null {
  switch (call.kind) {
    case 'write':
    case 'edit':
      return [call.path];
    case 'mcp': {
      const paths = mcpPaths(call, ctx, 'write');
      return paths.length === 0 ? null : paths;
    }
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
