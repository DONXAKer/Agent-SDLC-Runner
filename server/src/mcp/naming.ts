/**
 * Имена инструментов внешних MCP-серверов.
 *
 * Форма одна на оба флоу — `mcp__<сервер>__<инструмент>`, та же, что у Claude Code.
 * Разбор живёт в `exec/normalize.ts` (`parseMcpName`), потому что там же живёт разбор
 * всех остальных имён; здесь только сборка и проверка пригодности.
 */

const PREFIX = 'mcp__';

/**
 * Потолок длины имени функции у OpenAI-совместимых серверов.
 *
 * Флоу `loop` отдаёт имена в поле `function.name`, и часть серверов валидирует его по
 * `^[a-zA-Z0-9_-]{1,64}$`. Имя длиннее одни отвергнут ошибкой, другие обрежут — и вызов
 * вернётся под именем, которого мы не узнаем.
 */
export const MAX_TOOL_NAME = 64;

export function fullName(server: string, tool: string): string {
  return `${PREFIX}${server}__${tool}`;
}

/** Годится ли имя для передачи модели. Причина — текстом, чтобы её было видно оператору. */
export function nameProblem(server: string, tool: string): string | null {
  const name = fullName(server, tool);
  if (name.length > MAX_TOOL_NAME) {
    return `имя «${name}» длиннее ${MAX_TOOL_NAME} символов — часть провайдеров его отвергнет`;
  }
  if (!/^[A-Za-z0-9_-]+$/.test(name)) {
    return `имя «${name}» содержит символы вне [A-Za-z0-9_-]`;
  }
  return null;
}
