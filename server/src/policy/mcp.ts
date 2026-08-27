/**
 * Разрешительный список инструментов внешних MCP-серверов.
 *
 * Здесь один вопрос и один ответ на него: что этому вызову разрешено и меняет ли он
 * состояние. Второй способ это выяснить разошёлся бы с первым молча — поэтому `ruleFor`
 * зовут все, кому нужен класс вызова: проверка прав этапа, гейт одобрения, расчёт целей
 * записи и правила автоодобрения.
 *
 * Эвристики по имени тут нет намеренно. `tick_world`, `pie_start` и `compile_blueprint`
 * читающими не являются, `find_*`/`get_*` ничего не гарантируют, а `readOnlyHint` сервера —
 * утверждение той стороны, которую гейт и сторожит. Класс инструмента называет человек.
 */

import type { McpToolRule, NormalizedCall, PolicyContext } from '@sdlc-runner/shared';

export type McpCall = Extract<NormalizedCall, { kind: 'mcp' }>;

/** Шаблон — имя с одной завершающей `*`. Всё остальное сверяется дословно. */
function isPattern(tool: string): boolean {
  return tool.endsWith('*');
}

function matches(rule: McpToolRule, call: McpCall): boolean {
  if (rule.server !== call.server) return false;
  if (!isPattern(rule.tool)) return rule.tool === call.tool;
  return call.tool.startsWith(rule.tool.slice(0, -1));
}

/**
 * Правило-пол: правило, объявившее аргумент-путь на запись, читающим не бывает.
 *
 * Конфиг такое сочетание отвергает при загрузке, но политика не имеет права опираться на
 * то, что его отвергли: класс вызова решает, спросят ли человека вообще.
 */
function effectiveMode(rule: McpToolRule): McpToolRule['mode'] {
  if (rule.mode === 'read' && rule.pathArgs.some((a) => a.access === 'write')) return 'write';
  return rule.mode;
}

/**
 * Правило для вызова или `null`, если инструмент не разрешён.
 *
 * Разрешение конфликтов детерминированное: точное имя бьёт шаблон, среди шаблонов —
 * самый длинный префикс, при равной длине — более строгий класс. Иначе порядок строк в
 * конфиге менял бы права, а его никто не считает значимым.
 */
export function ruleFor(call: McpCall, ctx: PolicyContext): McpToolRule | null {
  let best: McpToolRule | null = null;
  let bestScore = -1;

  for (const rule of ctx.mcpTools) {
    if (!matches(rule, call)) continue;
    const score = isPattern(rule.tool) ? rule.tool.length - 1 : Number.MAX_SAFE_INTEGER;
    if (score > bestScore) {
      best = rule;
      bestScore = score;
      continue;
    }
    if (score === bestScore && best !== null && effectiveMode(rule) === 'write') best = rule;
  }

  return best;
}

/** Читает вызов или меняет состояние. `null` — правила нет, вызов запрещён. */
export function modeOf(call: McpCall, ctx: PolicyContext): McpToolRule['mode'] | null {
  const rule = ruleFor(call, ctx);
  return rule === null ? null : effectiveMode(rule);
}

/**
 * Пути файловой системы в аргументах вызова — только те, что человек объявил путями.
 *
 * Скан «строк, похожих на путь» здесь был бы хуже, чем ничего: `/Game/Cards/BP_Card`
 * проходит `isAbsolute`, лежит вне проекта и получил бы отказ, который оператор снять не
 * может, — на КАЖДОМ вызове, работающем с ассетами Unreal.
 */
export function mcpPaths(call: McpCall, ctx: PolicyContext, access: 'read' | 'write'): string[] {
  const rule = ruleFor(call, ctx);
  if (rule === null) return [];

  const out: string[] = [];
  for (const arg of rule.pathArgs) {
    if (arg.access !== access) continue;
    const value = call.args[arg.key];
    if (typeof value === 'string' && value !== '') out.push(value);
  }
  return out;
}

/** Сколько имён разрешённых инструментов показывать в отказе. */
const HINT_LIMIT = 15;

/**
 * Подсказка «а что разрешено» для отказа — только по тому же серверу и с потолком.
 *
 * Полный список на сотню имён съедает ход модели целиком и вытесняет из контекста то,
 * ради чего ход делался.
 */
export function allowedHint(server: string, ctx: PolicyContext): string {
  const names = ctx.mcpTools.filter((r) => r.server === server).map((r) => r.tool);
  if (names.length === 0) return 'ни одного';
  const head = names.slice(0, HINT_LIMIT).join(', ');
  return names.length <= HINT_LIMIT ? head : `${head} и ещё ${names.length - HINT_LIMIT}`;
}
