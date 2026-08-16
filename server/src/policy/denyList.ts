/**
 * Пол безопасности: категории, которые запрещены всегда и не расширяются настройкой этапа.
 *
 * Порт списка из AI-Workflow (`tools/DenyList.java`). Смысл в том, что это не «политика
 * проекта», которую можно ослабить в конфиге, а нижняя граница: конфиг может сделать
 * запреты строже, но не мягче.
 *
 * Две вещи здесь стоят отдельного внимания, потому что их отсутствие ревью поймало на
 * живом коде:
 *
 *  1. **Путь нормализуется перед сверкой.** Шаблоны якорятся на `/`, а модель на Windows
 *     присылает `src\.env` и `.git\config`. Без нормализации весь список обходился одним
 *     обратным слэшем — проверено прогоном.
 *  2. **Команда сводится к нижнему регистру и разэкранируется.** `RM -RF` и `rm\ -rf`
 *     обходили список, потому что ни одна регулярка не имела флага `i`, а Java-оригинал
 *     делал `toLowerCase()` и `replace("\\ ", " ")`.
 */

import type { NormalizedCall, PolicyVerdict } from '@sdlc-runner/shared';
import { POLICY_OK, policyDeny } from '@sdlc-runner/shared';

import { lexicalNormalize, toPosix } from './paths.ts';
import { redirectTargets } from './shellRedirects.ts';

/** Файлы, запись в которые отклоняется независимо от плана и этапа. */
const DENIED_WRITE: { re: RegExp; what: string }[] = [
  { re: /(^|\/)\.env(\.|$)/i, what: 'файл окружения' },
  { re: /\.(pem|key|p12|pfx|jks|keystore)$/i, what: 'сертификат или ключ' },
  { re: /(^|\/)id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i, what: 'SSH-ключ' },
  { re: /(^|\/)\.ssh\//i, what: 'каталог SSH' },
  { re: /(^|\/)\.git\/./i, what: 'внутренности git' },
  { re: /(^|\/)credentials(\.json|\.yaml|\.yml)?$/i, what: 'файл учётных данных' },
  { re: /\.credentials$/i, what: 'файл учётных данных' },
  { re: /(^|\/)\.npmrc$/i, what: 'токен реестра пакетов' },
  { re: /(^|\/)\.aws\//i, what: 'учётные данные AWS' },
];

/** Команды, отклоняемые целиком. Проверяются по нормализованной строке. */
const DENIED_BASH: { re: RegExp; what: string }[] = [
  { re: /\bgit\b[^\n]*\bpush\b[^\n]*--force(?!-with-lease)/, what: 'git push --force' },
  { re: /\bgit\b[^\n]*\bpush\b[^\n]*\s-[a-z]*f(\s|$)/, what: 'git push -f' },
  // `git push origin +main` — форс через refspec, обходил проверку по флагам.
  { re: /\bgit\b[^\n]*\bpush\b[^\n]*\s\+[a-z0-9._/-]+(\s|$)/, what: 'git push с force-refspec' },
  { re: /\bgit\b[^\n]*\breset\b[^\n]*--hard/, what: 'git reset --hard' },
  { re: /\bgit\b[^\n]*\bclean\b[^\n]*\s-[a-z]*f/, what: 'git clean -f' },
  { re: /\bchmod\b[^\n]*\s-[a-z]*r[a-z]*\s/, what: 'рекурсивный chmod' },
  { re: /\bchown\b[^\n]*\s-[a-z]*r[a-z]*\s/, what: 'рекурсивный chown' },
  { re: /\bsudo\b/, what: 'sudo' },
  { re: /\bdoas\b/, what: 'doas' },
  // Пайп в интерпретатор: `curl … | sh`, `cat x | zsh`, `… | /bin/bash`.
  {
    re: /\|\s*(\S*\/)?(sh|bash|zsh|dash|ash|ksh|python3?|perl|ruby|node|nodejs)\b/,
    what: 'пайп в интерпретатор',
  },
  // Однострочник интерпретатора — обход всех файловых проверок разом.
  {
    re: /\b(python3?|perl|ruby|node|nodejs|php|deno|bun)\b[^\n|]*\s(-{1,2}(c|e|eval|exec))\b/,
    what: 'однострочник интерпретатора',
  },
  { re: /\beval\b/, what: 'eval' },
  { re: /\bbase64\b[^\n]*\s-{1,2}(d|decode)\b/, what: 'декодирование base64' },
  { re: /\bmkfs\b|\bdd\b[^\n]*\bof=\/dev\//, what: 'операция с устройством' },
];

/**
 * Разэкранирование и нижний регистр — как в Java-оригинале. Без первого `rm\ -rf`
 * проходил, без второго — `RM -RF`.
 */
function normalizeCommand(cmd: string): string {
  return cmd.replace(/\\ /g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
}

/** Путь в форме, на которую рассчитаны шаблоны: прямые слэши, без `.` и `..`. */
function normalizeForMatch(p: string): string {
  const posix = toPosix(p.trim());
  const normalized = lexicalNormalize(posix);
  // Оставляем и исходную форму: нормализация схлопывает `..`, а шаблон может
  // целиться именно в промежуточный сегмент.
  return normalized === '' ? posix : normalized;
}

/**
 * `rm -rf` в любом написании: флаги вместе, врозь, длинными именами, в любом порядке.
 * Регуляркой это выражается плохо, поэтому флаги собираются и проверяются отдельно.
 */
function isRecursiveForceRemove(cmd: string): boolean {
  const re = /\brm\b((?:\s+-{1,2}[a-z-]+)+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(cmd)) !== null) {
    const flags = (m[1] ?? '').toLowerCase();
    const recursive = /(^|\s)-{1,2}[a-z-]*r/.test(flags) || flags.includes('recursive');
    const force = /(^|\s)-{1,2}[a-z-]*f/.test(flags) || flags.includes('force');
    if (recursive && force) return true;
  }
  return false;
}

export function checkWritePath(rawPath: string): PolicyVerdict {
  const candidates = new Set([normalizeForMatch(rawPath), toPosix(rawPath.trim())]);
  for (const { re, what } of DENIED_WRITE) {
    for (const p of candidates) {
      if (re.test(p)) {
        return policyDeny(
          'denyList',
          `запись в «${rawPath}» отклонена: ${what}. Этот запрет не снимается настройкой этапа.`,
        );
      }
    }
  }
  return POLICY_OK;
}

export function checkBash(command: string): PolicyVerdict {
  const normalized = normalizeCommand(command);

  if (isRecursiveForceRemove(normalized)) {
    return policyDeny(
      'denyList',
      'команда отклонена: рекурсивное удаление (rm -rf). Этот запрет не снимается настройкой этапа.',
    );
  }

  for (const { re, what } of DENIED_BASH) {
    if (re.test(normalized)) {
      return policyDeny(
        'denyList',
        `команда отклонена: ${what}. Этот запрет не снимается настройкой этапа.`,
      );
    }
  }

  // Редирект в запрещённую категорию — та же запись, просто через шелл. Цели с
  // неразвёрнутой переменной здесь тоже проверяются: `> $PWD/.env` — всё ещё `.env`.
  for (const target of redirectTargets(command)) {
    const v = checkWritePath(target.path);
    if (!v.ok) return v;
  }

  return POLICY_OK;
}

export function check(call: NormalizedCall): PolicyVerdict {
  switch (call.kind) {
    case 'write':
    case 'edit':
      return checkWritePath(call.path);
    case 'bash':
      return checkBash(call.command);
    default:
      return POLICY_OK;
  }
}
