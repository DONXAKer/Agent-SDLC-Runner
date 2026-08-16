/**
 * Файлы, в которые командная строка что-то запишет: цели `>`, `>>`, `>|` и аргументы
 * `tee`, с рекурсией в `sh -c "..."`.
 *
 * Это настоящий (маленький) лексер, а не регулярка. Порт из
 * `AI-Workflow/workflow-core/src/main/java/com/workflow/tools/PlanScope.java`, где каждая
 * попытка обойтись регуляркой ломалась в одну из двух сторон, и обе стоили реальных прогонов:
 *
 *  - слишком жадно — `grep -rn "Map<String,Object> ctx" src` читал `>` внутри кавычек как
 *    редирект, и чистое чтение возвращалось с «write refused». На такую ошибку модель
 *    ответить не может и ретраит, пока не кончится бюджет;
 *  - слишком мягко — затирание кавычек перед сканом делало `sh -c "echo x > f"` невидимым,
 *    то есть ровно тот обход, ради которого всё это и написано, открывался одним словом.
 *
 * Что НЕ покрыто осознанно: `cp`, `mv`, `touch`, `sed -i`, `npm init`, `npx jest --init`.
 * Здесь быстрый забор вокруг конструкции, к которой модели реально тянутся, а не песочница.
 */

const SHELLS = new Set(['sh', 'bash', 'dash', 'zsh', 'ash', 'ksh']);

/**
 * Обёртки, за которыми прячется настоящая команда. Без них `nohup sh -c "echo x > f"`
 * проходил мимо лексера целиком — обход открывался одним словом-префиксом, что ревью и
 * поймало на живом коде.
 */
const WRAPPERS = new Set([
  'nohup',
  'env',
  'timeout',
  'time',
  'stdbuf',
  'nice',
  'ionice',
  'setsid',
  'command',
  'exec',
  'sudo',
  'doas',
  'xargs',
  'script',
]);

const OPERATOR_CHARS = '|;&<>()';

/** Аргумент обёртки, который заведомо не является именем команды. */
const WRAPPER_ARG = /^(-|--$|[A-Za-z_][A-Za-z0-9_]*=|\d+(\.\d+)?[smhd]?$)/;

/** `-c`, `-lc`, `-ec`, `--command`: следующее слово — тело скрипта. */
const SHELL_C_FLAG = /^(-[a-z]*c|--command)$/;

export interface RedirectTarget {
  path: string;
  /**
   * Путь содержит неразвёрнутую переменную. О таком нельзя судить как о плановом файле,
   * но запрещённую категорию в нём разглядеть можно: `> $PWD/.env` это всё ещё `.env`.
   */
  unexpanded: boolean;
}

interface Tok {
  text: string;
  op: boolean;
  quoted: boolean;
}

export function redirectTargets(command: string): RedirectTarget[] {
  if (!command) return [];
  return targetsOf(stripHeredocBodies(command), 0);
}

/** Только те цели, о которых можно судить как о путях: для сверки с планом. */
export function expandedRedirectTargets(command: string): string[] {
  return redirectTargets(command)
    .filter((t) => !t.unexpanded)
    .map((t) => t.path);
}

function targetsOf(command: string, depth: number): RedirectTarget[] {
  const out: RedirectTarget[] = [];
  // Незакрытая кавычка означает, что правила квотирования эту строку не описывают:
  // `echo don't > STATUS.md` иначе заглушил бы всё после апострофа. Для шелла это тоже
  // синтаксическая ошибка, так что откатом в quote-blind режим ничего не теряется —
  // пропустить редирект дороже, чем лишний раз его увидеть.
  const toks = lex(command, !hasUnbalancedQuote(command));
  let commandPosition = true;
  /** Идём сквозь аргументы обёртки, всё ещё разыскивая настоящее имя команды. */
  let unwrapping = false;

  for (let i = 0; i < toks.length; i++) {
    const t = toks[i]!;

    if (t.op) {
      // ">&" / "2>&1" дублируют дескриптор — файла тут нет.
      if (t.text.startsWith('>') && !t.text.includes('&')) {
        const target = nextWord(toks, i);
        if (target !== null) collect(out, target.text);
      }
      // После редиректа следующее слово — его цель, а не имя команды.
      commandPosition = !t.text.startsWith('>') && !t.text.startsWith('<');
      unwrapping = false;
      continue;
    }

    if (commandPosition) {
      const name = baseName(t.text);

      if (unwrapping && WRAPPER_ARG.test(t.text)) continue; // аргумент обёртки, не команда

      if (WRAPPERS.has(name)) {
        unwrapping = true;
        continue; // настоящая команда ещё впереди
      }

      unwrapping = false;

      if (name === 'tee') {
        // Каждый нефлаговый аргумент — файл, в который tee пишет. Флаги слишком
        // разнообразны, чтобы их перечислять (-a, --append, -i, -p ...), поэтому
        // отбрасываются по форме.
        for (let j = i + 1; j < toks.length && !toks[j]!.op; j++) {
          const arg = toks[j]!;
          if (!arg.quoted && arg.text.startsWith('-')) continue;
          collect(out, arg.text);
        }
      } else if (SHELLS.has(name) && depth < 2) {
        for (let j = i + 1; j < toks.length && !toks[j]!.op; j++) {
          if (SHELL_C_FLAG.test(toks[j]!.text) && j + 1 < toks.length && !toks[j + 1]!.op) {
            out.push(...targetsOf(toks[j + 1]!.text, depth + 1));
            break;
          }
        }
      }
    }

    commandPosition = false;
  }

  return out;
}

function collect(out: RedirectTarget[], target: string): void {
  if (target.trim() === '' || target.startsWith('/dev/') || target.startsWith('&')) return;
  out.push({ path: target, unexpanded: target.includes('$') });
}

function nextWord(toks: Tok[], from: number): Tok | null {
  const t = toks[from + 1];
  if (t === undefined) return null;
  return t.op ? null : t; // другой оператор сразу после редиректа — строка кривая, пропускаем
}

function baseName(s: string): string {
  const slash = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
  return slash < 0 ? s : s.slice(slash + 1);
}

/**
 * Разбивает командную строку на слова и операторы, разрешая кавычки и экранирование
 * обратным слэшем. Переводы строк — операторы: они разделяют команды, и обращение с ними
 * как с обычным текстом давало цели вида `report.md\nls` — путь, которого не может быть.
 *
 * Пробельность считается по ASCII, а не по `\s`: JS-`\s` включает NBSP и BOM, которых
 * шелл разделителями не считает, и имя файла, скопированное из markdown-плана, ломалось
 * пополам.
 */
function isShellSpace(c: string): boolean {
  return c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f' || c === '\v';
}

function lex(s: string, honourQuotes: boolean): Tok[] {
  const out: Tok[] = [];
  let cur = '';
  let started = false;
  let quoted = false;
  let i = 0;
  const n = s.length;

  const flush = (): void => {
    if (started) {
      out.push({ text: cur, op: false, quoted });
      cur = '';
      started = false;
      quoted = false;
    }
  };

  while (i < n) {
    const c = s[i]!;

    if (c === '\\' && i + 1 < n) {
      cur += s[i + 1]!;
      started = true;
      i += 2;
      continue;
    }

    if (honourQuotes && (c === '"' || c === "'")) {
      const q = c;
      started = true;
      quoted = true;
      i++;
      while (i < n && s[i] !== q) {
        if (q === '"' && s[i] === '\\' && i + 1 < n) {
          cur += s[i + 1]!;
          i += 2;
          continue;
        }
        cur += s[i]!;
        i++;
      }
      i++; // закрывающая кавычка, или за концом строки для незакрытой
      continue;
    }

    if (isShellSpace(c)) {
      flush();
      if (c === '\n' || c === '\r') out.push({ text: '\n', op: true, quoted: false });
      i++;
      continue;
    }

    if (OPERATOR_CHARS.includes(c)) {
      flush();
      let j = i;
      while (j < n && OPERATOR_CHARS.includes(s[j]!)) j++;
      out.push({ text: s.slice(i, j), op: true, quoted: false });
      i = j;
      continue;
    }

    cur += c;
    started = true;
    i++;
  }

  flush();
  return out;
}

/** Кавычка открыта и не закрыта — строка не является валидным shell. */
function hasUnbalancedQuote(s: string): boolean {
  let open = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (c === '\\' && i + 1 < s.length && open !== "'") {
      i++;
      continue;
    }
    if (open === '' && (c === '"' || c === "'")) open = c;
    else if (open === c) open = '';
  }
  return open !== '';
}

const HEREDOC = /<<-?\s*['"]?([A-Za-z_][A-Za-z0-9_]*)['"]?/;

/**
 * Выбрасывает тела heredoc. Их содержимое — данные, а не синтаксис шелла, и случайное
 * `if (a > b)` внутри всплывало как редирект в файл `b)`.
 */
function stripHeredocBodies(s: string): string {
  if (!s.includes('<<')) return s;

  let text = s;
  let from = 0;

  for (;;) {
    const rest = text.slice(from);
    const m = HEREDOC.exec(rest);
    if (m === null) break;

    const matchStart = from + m.index;
    const matchEnd = matchStart + m[0].length;
    const label = m[1]!;

    const lineEnd = text.indexOf('\n', matchEnd);
    if (lineEnd < 0) break; // тела нет вовсе

    const bodyStart = lineEnd + 1;
    const bodyEnd = indexOfLine(text, label, bodyStart);
    if (bodyEnd < 0) {
      from = matchEnd;
      continue;
    }

    text = text.slice(0, bodyStart) + text.slice(bodyEnd);
    from = lineEnd;
  }

  return text;
}

/** Смещение строки, содержимое которой после trim равно label, начиная с from. */
function indexOfLine(s: string, label: string, from: number): number {
  let i = from;
  while (i < s.length) {
    let end = s.indexOf('\n', i);
    if (end < 0) end = s.length;
    if (s.slice(i, end).trim() === label) return i;
    i = end + 1;
  }
  return -1;
}
