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

import type { Decision, NormalizedCall, PreparedPrompt, ToolName, Usage } from '@sdlc-runner/shared';

export interface ExecHooks {
  /** Текст ассистента по мере поступления. */
  onText: (text: string) => void;
  onThinking: (text: string) => void;
  /**
   * Единственная точка, через которую проходит вызов инструмента. Держит промис, пока
   * политика и оператор не дадут ответ.
   */
  onToolRequest: (
    call: NormalizedCall,
    /**
     * `toolName` — как вызов назвал исполнитель: по нему гейт перепроверяет правку.
     * `rawInput` — аргументы инструмента ДО нормализации. Нужны для правки оператором:
     * интерфейс присылает только изменённые поля, и без исходных мержить их не с чем —
     * `Edit` с правленым путём приходил без `new_string`, и одобренная правка стирала
     * файл вместо замены строки.
     */
    meta: { requestId: string; toolName: string; rawInput: Record<string, unknown> },
  ) => Promise<Decision>;
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

/** Субагент этапа: у него собственные права, и это конструкция, а не просьба. */
export interface SubagentDef {
  name: string;
  description: string;
  prompt: string;
  tools: string[];
  model: string | null;
}

export interface ExecRequest {
  prompt: PreparedPrompt;
  /** Корень целевого проекта — рабочий каталог агента. */
  cwd: string;
  model: string;
  allowedTools: readonly ToolName[];
  /** Каталоги вне проекта, доступные агенту на чтение (формы методологии, тексты этапов). */
  readOnlyDirs: readonly string[];
  /** Субагенты, доступные на этом этапе. */
  subagents: readonly SubagentDef[];
  maxTurns: number;
  maxBudgetUsd: number | null;
  /**
   * Отмена прогона. Без неё «отменить» только меняло статус в UI, а исполнитель
   * продолжал крутиться, тратя бюджет и создавая новые запросы на одобрение.
   */
  signal: AbortSignal;
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
