/** Инструмент внешнего MCP-сервера так, как его отдал сам сервер. */
export interface McpToolInfo {
  server: string;
  tool: string;
  /** Полное имя на проводе: `mcp__<сервер>__<инструмент>`. */
  name: string;
  description: string;
  schema: Record<string, unknown>;
  /**
   * Аннотации сервера. Показываются оператору как подсказка при составлении списка и
   * НИКОГДА не используются как решение о правах: это утверждение той стороны, которую
   * гейт и сторожит.
   */
  readOnlyHint: boolean | null;
  destructiveHint: boolean | null;
}

/** Результат вызова инструмента, уже свёрнутый в текст для модели. */
export interface McpCallOutcome {
  ok: boolean;
  text: string;
}
