/**
 * Приведение вызова инструмента к `NormalizedCall`.
 *
 * Это единственное место в рантайме, где различия между именами и аргументами инструментов
 * флоу `sdk` и флоу `loop` вообще имеют значение. Дальше по течению — политика доступа,
 * панель одобрений, журнал — видят одну форму, и потому не могут разъехаться.
 *
 * Незнакомый инструмент нормализуется в `unknown`, а не отбрасывается: политика обязана
 * считать его записью по худшему случаю и отклонить, а не пропустить молча.
 */

import type { CallKind, ClaimStatus, EditOp, GateStatus, NormalizedCall, Question } from '@sdlc-runner/shared';
import { FINDING_SECTIONS, isArtifactKey } from '@sdlc-runner/shared';

/** Инструменты, которые рантайм подаёт через MCP во флоу `sdk`. */
const MCP_PREFIX = 'mcp__sdlc__';

/**
 * Map, а не объектный литерал: у литерала есть прототип, и инструмент с именем `toString`
 * или `constructor` возвращал функцию вместо `undefined`. Тогда ни одна ветка switch не
 * срабатывала, `normalize` отдавал `undefined`, и политика падала с TypeError вместо
 * отказа по худшему случаю — то есть ровно наоборот к заявленному принципу.
 */
const NAME_TO_KIND = new Map<string, CallKind>([
  ['Read', 'read'],
  ['Glob', 'glob'],
  ['Grep', 'grep'],
  ['Write', 'write'],
  ['Edit', 'edit'],
  ['MultiEdit', 'edit'],
  ['Bash', 'bash'],
  ['AskHuman', 'ask_human'],
  ['ask_human', 'ask_human'],
  ['FinalizeArtifact', 'finalize_artifact'],
  ['finalize_artifact', 'finalize_artifact'],
  ['Task', 'subagent'],
  ['Agent', 'subagent'],
  ['RequestScopeExtension', 'request_scope_extension'],
  ['request_scope_extension', 'request_scope_extension'],
  ['RecordClaim', 'record_claim'],
  ['record_claim', 'record_claim'],
  ['RecordFinding', 'record_finding'],
  ['FillField', 'fill_field'],
  ['fill_field', 'fill_field'],
  ['record_finding', 'record_finding'],
]);

function str(input: Record<string, unknown>, ...keys: string[]): string | null {
  for (const k of keys) {
    const v = input[k];
    if (typeof v === 'string') return v;
  }
  return null;
}

/**
 * Статус пункта приёмки из строки модели. `null` — не одно из четырёх значений таблицы.
 *
 * Слова принимаются наравне со значками: локальная модель регулярно пишет `passed`/`failed`
 * вместо `✅`/`❌`, и отклонять такую запись значило бы мерить владение эмодзи, а не разбор.
 * Пятой градации нет: «частично» не превращается ни во что.
 */
export function claimStatusOf(raw: string): ClaimStatus | null {
  const t = raw.trim().toLowerCase();
  if (t.includes('✅') || t === 'passed' || t === 'pass' || t === 'true' || t === 'да') return '✅';
  if (t.includes('❌') || t === 'failed' || t === 'fail' || t === 'false' || t === 'нет') return '❌';
  if (t.includes('⚠') || t === 'unknown' || t === 'unverifiable') return '⚠';
  if (t === 'manual') return 'manual';
  return null;
}

/**
 * Статус гейта из строки модели — тот же словарь слов, что у пункта, плюс `⏭`.
 * Экспортирован рядом с `claimStatusOf`, а не скопирован в `artifacts/sheet.ts`:
 * словарь «слово → значок» один на рантайм.
 */
export function gateStatusOf(raw: string): GateStatus | null {
  const t = raw.trim().toLowerCase();
  if (t.includes('⏭') || t === 'skip' || t === 'skipped' || t === 'пропущен' || t === 'н/п') return '⏭';
  const claim = claimStatusOf(t);
  return claim === '✅' || claim === '❌' ? claim : null;
}

/** Имя пункта в канонической форме `claim-N`. `claim-3`, `Claim-3`, `3` — одно и то же. */
function claimIdOf(raw: string): string {
  const t = raw.replace(/`/g, '').trim().toLowerCase();
  const m = /^(?:claim-)?(\d+)\b/.exec(t);
  return m === null ? t : `claim-${m[1]!}`;
}

function num(input: Record<string, unknown>, key: string): number | null {
  const v = input[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function bool(input: Record<string, unknown>, key: string): boolean {
  return input[key] === true;
}

/**
 * Разбор правок. `null` — набор битый целиком.
 *
 * Некорректный элемент раньше молча выбрасывался, и пачка из трёх правок применялась
 * двумя: модель получала «применено» и считала, что прошли все три. Это ровно тот
 * частично применённый набор, от которого `editTool` защищается своим «ни одна правка не
 * применена» — защита обходилась на уровень выше, в нормализации.
 */
function editsOf(input: Record<string, unknown>): EditOp[] | null {
  const raw = input['edits'];
  if (Array.isArray(raw)) {
    const out: EditOp[] = [];
    for (const e of raw) {
      if (typeof e !== 'object' || e === null) return null;
      const r = e as Record<string, unknown>;
      const oldStr = str(r, 'old_string', 'oldString');
      const newStr = str(r, 'new_string', 'newString');
      if (oldStr === null || newStr === null) return null;
      out.push({ oldStr, newStr, replaceAll: bool(r, 'replace_all') || bool(r, 'replaceAll') });
    }
    return out;
  }

  const oldStr = str(input, 'old_string', 'oldString');
  const newStr = str(input, 'new_string', 'newString');
  if (oldStr === null || newStr === null) return [];
  return [
    { oldStr, newStr, replaceAll: bool(input, 'replace_all') || bool(input, 'replaceAll') },
  ];
}

function questionsOf(input: Record<string, unknown>): Question[] {
  const raw = input['questions'];
  if (!Array.isArray(raw)) return [];
  const out: Question[] = [];
  raw.forEach((q, i) => {
    if (typeof q !== 'object' || q === null) return;
    const r = q as Record<string, unknown>;
    const question = str(r, 'question');
    if (question === null) return;
    const optionsRaw = Array.isArray(r['options']) ? (r['options'] as unknown[]) : [];
    const options = optionsRaw.flatMap((o) => {
      if (typeof o !== 'object' || o === null) return [];
      const or = o as Record<string, unknown>;
      const label = str(or, 'label');
      if (label === null) return [];
      return [{ label, description: str(or, 'description') ?? '' }];
    });
    out.push({
      id: str(r, 'id') ?? `q${i + 1}`,
      question,
      header: str(r, 'header') ?? '',
      multiSelect: bool(r, 'multiSelect'),
      options,
    });
  });
  return out;
}

/** Имя инструмента без транспортного префикса нашего MCP-сервера. */
export function baseToolName(toolName: string): string {
  return toolName.startsWith(MCP_PREFIX) ? toolName.slice(MCP_PREFIX.length) : toolName;
}

/** Общий префикс имён MCP-инструментов у Claude Code — и у нас, в обоих флоу. */
const MCP_ANY_PREFIX = 'mcp__';

/**
 * Разбор имени инструмента внешнего MCP-сервера: `mcp__<сервер>__<инструмент>`.
 *
 * Режем по ПЕРВОМУ `__` после префикса: имя сервера приходит ключом `.mcp.json` и нами
 * проверяется, а имя инструмента — дело сервера и вполне может содержать `__`.
 *
 * Сервер `sdlc` зарезервирован за нашим in-process сервером и здесь даёт `null`. Иначе
 * `mcp__sdlc__что_то_неизвестное` (префикс снят, в `NAME_TO_KIND` не найдено) превратился
 * бы из `unknown` в законный вызов к серверу, которого нет.
 */
export function parseMcpName(toolName: string): { server: string; tool: string } | null {
  if (!toolName.startsWith(MCP_ANY_PREFIX)) return null;
  const rest = toolName.slice(MCP_ANY_PREFIX.length);
  const sep = rest.indexOf('__');
  if (sep <= 0) return null;
  const server = rest.slice(0, sep);
  const tool = rest.slice(sep + 2);
  if (server === '' || tool === '' || server === 'sdlc') return null;
  return { server, tool };
}

export function normalize(toolName: string, input: Record<string, unknown>): NormalizedCall {
  const name = baseToolName(toolName);
  const kind = NAME_TO_KIND.get(name);

  if (kind === undefined) {
    const mcp = parseMcpName(toolName);
    if (mcp !== null) return { kind: 'mcp', server: mcp.server, tool: mcp.tool, args: input };
    return { kind: 'unknown', toolName, raw: input };
  }

  switch (kind) {
    case 'read': {
      const path = str(input, 'file_path', 'path', 'filePath');
      if (path === null) return { kind: 'unknown', toolName, raw: input };
      const offset = num(input, 'offset');
      const limit = num(input, 'limit');
      if (offset === null && limit === null) return { kind: 'read', path, range: null };

      const from = Math.max(1, offset ?? 1);
      // `offset` без `limit` — это «отсюда и до конца файла», как в Claude Code, на
      // семантике которого модель обучена. Пока это давало одну строку, модель после
      // отказа «читай диапазоном» выедала бюджет ходов по строке за ход.
      // Диапазон включающий: `offset=10, limit=5` это строки 10..14, а не 10..15.
      const to = limit === null ? null : from + Math.max(1, limit) - 1;
      return { kind: 'read', path, range: { from, to } };
    }

    case 'glob': {
      const pattern = str(input, 'pattern');
      if (pattern === null) return { kind: 'unknown', toolName, raw: input };
      return { kind: 'glob', pattern, path: str(input, 'path') };
    }

    case 'grep': {
      const pattern = str(input, 'pattern');
      if (pattern === null) return { kind: 'unknown', toolName, raw: input };
      return { kind: 'grep', pattern, path: str(input, 'path') };
    }

    case 'write': {
      const path = str(input, 'file_path', 'path', 'filePath');
      if (path === null) return { kind: 'unknown', toolName, raw: input };
      return { kind: 'write', path, content: str(input, 'content') ?? '' };
    }

    case 'edit': {
      const path = str(input, 'file_path', 'path', 'filePath');
      if (path === null) return { kind: 'unknown', toolName, raw: input };
      const edits = editsOf(input);
      // Правка без единой операции — не правка, а набор с битым элементом — не набор.
      // И то и другое пусть политика отклонит как незнакомый вызов, а не пропустит как
      // безобидный.
      if (edits === null || edits.length === 0) return { kind: 'unknown', toolName, raw: input };
      return { kind: 'edit', path, edits };
    }

    case 'bash': {
      const command = str(input, 'command');
      if (command === null) return { kind: 'unknown', toolName, raw: input };
      return { kind: 'bash', command };
    }

    case 'ask_human':
      return { kind: 'ask_human', questions: questionsOf(input) };

    case 'finalize_artifact': {
      const artifact = str(input, 'artifact', 'file_path', 'path');
      if (artifact === null) return { kind: 'unknown', toolName, raw: input };
      return { kind: 'finalize_artifact', artifact, note: str(input, 'note') };
    }

    case 'subagent': {
      const agent = str(input, 'subagent_type', 'agent', 'name');
      if (agent === null) return { kind: 'unknown', toolName, raw: input };
      return { kind: 'subagent', agent, prompt: str(input, 'prompt', 'description') ?? '' };
    }

    case 'request_scope_extension': {
      const path = str(input, 'path', 'file_path');
      const reason = str(input, 'reason');
      if (path === null || reason === null) return { kind: 'unknown', toolName, raw: input };
      return { kind: 'request_scope_extension', path, reason };
    }

    case 'record_claim': {
      const id = str(input, 'id', 'claim', 'claim_id');
      const status = str(input, 'status', 'passed');
      const evidence = str(input, 'evidence', 'proof', 'confirmed_by');
      if (id === null || status === null || evidence === null) {
        return { kind: 'unknown', toolName, raw: input };
      }
      const claimStatus = claimStatusOf(status);
      // Статус вне четырёх значений методологии — это НЕ запись «на глазок»: пятой
      // градации у таблицы вердикта нет, и принять «частично» значило бы завести её
      // молча. Вызов уходит в `unknown`, то есть отклоняется политикой по худшему случаю,
      // и модель получает отказ с перечнем допустимых значений.
      if (claimStatus === null) return { kind: 'unknown', toolName, raw: input };
      const whatToFix = str(input, 'what_to_fix', 'whatToFix', 'fix');
      return {
        kind: 'record_claim',
        // `claim-3`, `Claim-3`, `3` — одно и то же имя пункта. Приведение здесь, а не у
        // читателя: иначе одна и та же запись, сделанная дважды, дала бы две строки.
        id: claimIdOf(id),
        status: claimStatus,
        evidence,
        whatToFix,
      };
    }

    case 'record_finding': {
      const section = str(input, 'section', 'kind');
      const text = str(input, 'text', 'finding', 'what');
      if (section === null || text === null) return { kind: 'unknown', toolName, raw: input };
      const known = FINDING_SECTIONS.find((s) => s === section.trim().toLowerCase());
      if (known === undefined) return { kind: 'unknown', toolName, raw: input };
      return { kind: 'record_finding', section: known, text, evidence: str(input, 'evidence', 'where') ?? '' };
    }

    case 'fill_field': {
      const artifact = str(input, 'artifact');
      const field = str(input, 'field');
      const value = str(input, 'value');
      // Пустая СТРОКА — законный ответ для list/records («элементов нет» — applyFill сам
      // подставит альтернативу поля или откажет содержательным сообщением, если у поля её
      // нет). Нормализатор не знает вид поля (это знает только схема бланка, посчитанная
      // позже) и потому не вправе отклонять пустой value заранее — иначе у полей list/records
      // не остаётся ни одного законного способа сказать «пусто» вне `FormFillExecutor`.
      // Отклоняется только ОТСУТСТВУЮЩИЙ ключ (`value === null`), не его пустое значение.
      if (artifact === null || field === null || value === null) {
        return { kind: 'unknown', toolName, raw: input };
      }
      if (!isArtifactKey(artifact)) return { kind: 'unknown', toolName, raw: input };
      const opRaw = str(input, 'op');
      const op = opRaw === 'add' ? 'add' : 'set';
      return { kind: 'fill_field', artifact, field, value, op };
    }

    // Недостижимо: `mcp` не приходит из `NAME_TO_KIND` — вызовы внешних серверов узнаются
    // по префиксу имени выше и до switch'а не доходят. Ветка стоит ради исчерпывающего
    // switch: без неё пропуск НАСТОЯЩЕГО нового вида перестал бы быть ошибкой сборки.
    case 'mcp':
    case 'unknown':
      return { kind: 'unknown', toolName, raw: input };
  }
}
