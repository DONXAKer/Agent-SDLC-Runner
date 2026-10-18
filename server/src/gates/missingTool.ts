/**
 * Отсутствующий инструмент команды — улика, а не догадка. Порт `sdlc_common.missing_tool`
 * методологии, ужесточённый: строка-диагностика оболочки обязана назвать САМ инструмент
 * команды как отдельное слово (первый токен или его базовое имя, в кавычках или между
 * пробелами/двоеточиями), иначе «No such file or directory» из лога тестов — где тест
 * честно проверяет отсутствующий файл, а в пути стоит `node_modules` — читалось бы отказом
 * среды и уводило виток в `blocked_env` вместо красного по делу (ревью, подтверждено).
 *
 * Возвращает строку-улику (что именно сказала оболочка) либо `null`. Коды 127 (POSIX:
 * команда не найдена) и 9009 (cmd.exe) — улика сами по себе: первая непустая строка вывода
 * или сам код. 126 («найдена, но не исполняется», `./gradlew` без `+x`) — не среда: по
 * `SDLC.md` это лень исполнителя и обычный retry (`chmod +x`).
 */

const MISSING_TOOL_RE =
  /command not found|not recognized as an internal or external command|No such file or directory|не является внутренней или внешней|is not recognized|CreateProcess error=2|No Java runtime|JAVA_HOME is not set/i;

/** Первый токен команды без префиксов окружения `VAR=x`. */
export function firstToken(cmd: string): string {
  for (const part of cmd.split(/\s+/)) {
    if (part === '') continue;
    if (part.includes('=') && !/^(\.\/|\.\\|\/)/.test(part) && !part.includes('/') && !part.includes('\\')) {
      continue;
    }
    return part;
  }
  return '';
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Инструмент назван в строке отдельным словом: в кавычках, после `bash:`/пробела, не внутри пути. */
function namesTool(line: string, tool: string): boolean {
  return new RegExp(`(^|[\\s'"\`:(])${escapeRe(tool)}([\\s'"\`:),]|$)`).test(line);
}

export function missingTool(output: string, cmd: string, exitCode: number | null): string | null {
  if (exitCode === 127 || exitCode === 9009) {
    const first = output.split(/\r?\n/).find((ln) => ln.trim() !== '');
    return (first ?? `код возврата ${exitCode}`).trim().slice(0, 200);
  }
  const tok = firstToken(cmd);
  if (tok === '') return null;
  const base = tok.replace(/\\/g, '/').split('/').pop() ?? '';
  const names = [tok, ...(base !== '' && base !== tok ? [base] : [])];
  for (const ln of output.split(/\r?\n/)) {
    if (!MISSING_TOOL_RE.test(ln)) continue;
    if (names.some((n) => namesTool(ln, n))) return ln.trim().slice(0, 200);
  }
  return null;
}
