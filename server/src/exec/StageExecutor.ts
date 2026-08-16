/**
 * Интерфейс исполнителя этапа — уровень этапа, а не отдельного запроса.
 *
 * Реализаций две: `SdkExecutor` (Claude через Agent SDK, оплата по Max-подписке) и
 * `LoopExecutor` (свой цикл tool-use для локальных моделей). UI не знает, какая из них
 * работает — кроме бейджа маршрута в шапке.
 *
 * Всё, что похоже на политику, живёт не здесь: исполнитель обязан нормализовать вызов и
 * отдать его в `onToolRequest`, а решение принимают общие для обоих флоу чистые функции.
 */

import type { Decision, NormalizedCall, PreparedPrompt, ToolName, Usage } from '../types.ts';

export interface ExecHooks {
  /** Текст ассистента по мере поступления. */
  onText: (text: string) => void;
  onThinking: (text: string) => void;
  /**
   * Единственная точка, через которую проходит вызов инструмента. Держит промис, пока
   * политика и оператор не дадут ответ.
   */
  onToolRequest: (call: NormalizedCall, meta: { requestId: string }) => Promise<Decision>;
  onToolResult: (meta: {
    requestId: string;
    ok: boolean;
    summary: string;
    durationMs: number;
  }) => void;
  /** Вопрос человеку из инструмента `AskHuman`. Возвращает ответы по id вопроса. */
  onAskHuman: (call: NormalizedCall) => Promise<Record<string, string[]>>;
  onUsage: (usage: Usage) => void;
  /**
   * Диагностика, которая не роняет этап, но которую нельзя проглотить. Сюда попадает,
   * например, вызов инструмента, проскочивший мимо гейта одобрений.
   */
  onWarn: (message: string) => void;
}

export interface ExecRequest {
  prompt: PreparedPrompt;
  /** Корень целевого проекта — рабочий каталог агента. */
  cwd: string;
  model: string;
  allowedTools: readonly ToolName[];
  maxTurns: number;
  maxBudgetUsd: number | null;
}

export interface StageResult {
  ok: boolean;
  /** Последний текст ассистента — то, чем этап отчитался. */
  finalText: string;
  usage: Usage;
  /** Причина завершения человеческим языком. */
  note: string;
}

export interface StageExecutor {
  readonly flow: 'sdk' | 'loop';
  run(req: ExecRequest, hooks: ExecHooks): Promise<StageResult>;
}
