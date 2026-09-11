/**
 * Запись артефакта, собранного РАНТАЙМОМ, через тот же гейт, что у любой записи модели:
 * нормализованный `Write` → `hooks.onToolRequest` (политика решает, оператор одобряет) →
 * `executeTool`. Второго места решения о доступе не появляется — это главное требование к
 * любому конвейеру (`FormFillExecutor`, `StepExecutor`, `ExploreExecutor`).
 *
 * Вынесено из `FormFillExecutor.flushArtifact`: конвейер разведки пишет тем же путём, и
 * вторая копия «нормализовать — спросить гейт — исполнить» разошлась бы с первой при первой
 * же правке (например, учёта `updatedInput` оператора).
 */

import { randomUUID } from 'node:crypto';
import { relative } from 'node:path';

import { normalize } from './normalize.ts';
import type { ExecHooks, ExecRequest } from './StageExecutor.ts';
import { executeTool, type ToolContext } from './tools/index.ts';

export type GateWriteResult =
  | { ok: true }
  /** Отказ гейта окончателен: повторять запись после явного «нет» нельзя. */
  | { ok: false; denied: true; reason: string }
  /** Сбой исполнения (fs): не решение человека, вызывающий вправе попробовать снова. */
  | { ok: false; denied: false; reason: string };

export async function writeThroughGate(
  hooks: ExecHooks,
  req: ExecRequest,
  toolCtx: ToolContext,
  path: string,
  text: string,
  idPrefix: string,
): Promise<GateWriteResult> {
  const rel = relative(req.cwd, path);
  const rawInput = { file_path: rel, content: text };
  const call = normalize('Write', rawInput);
  const requestId = `${idPrefix}:${randomUUID()}`;
  const decision = await hooks.onToolRequest(call, {
    requestId,
    toolName: 'Write',
    rawInput,
    callerTools: req.allowedTools,
  });
  if (!decision.allowed) {
    hooks.onFriction('denied');
    hooks.onToolResult({ requestId, ok: false, summary: decision.reason, durationMs: 0 });
    return { ok: false, denied: true, reason: decision.reason };
  }
  const effective =
    decision.updatedInput === null ? call : normalize('Write', decision.updatedInput as Record<string, unknown>);
  const outcome = await executeTool(effective, toolCtx);
  hooks.onToolResult({
    requestId,
    ok: outcome.ok,
    summary: outcome.text.split('\n')[0]?.slice(0, 200) ?? '',
    durationMs: 0,
  });
  if (!outcome.ok) return { ok: false, denied: false, reason: outcome.text };
  return { ok: true };
}
