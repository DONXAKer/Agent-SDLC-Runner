/**
 * Пол безопасности: категории, которые запрещены всегда и не расширяются настройкой этапа.
 *
 * Порт списка из AI-Workflow (`tools/DenyList.java`). Смысл в том, что это не «политика
 * проекта», которую можно ослабить в конфиге, а нижняя граница: конфиг может сделать
 * запреты строже, но не мягче.
 */

import type { NormalizedCall, PolicyVerdict } from '../types.ts';
import { POLICY_OK, policyDeny } from '../types.ts';
import { redirectTargets } from './shellRedirects.ts';

/** Файлы, запись в которые отклоняется независимо от плана и этапа. */
const DENIED_WRITE: { re: RegExp; what: string }[] = [
  { re: /(^|\/)\.env(\.|$)/i, what: 'файл окружения' },
  { re: /\.pem$/i, what: 'сертификат/ключ' },
  { re: /\.key$/i, what: 'ключ' },
  { re: /(^|\/)id_(rsa|dsa|ecdsa|ed25519)$/i, what: 'приватный SSH-ключ' },
  { re: /(^|\/)\.ssh\//i, what: 'каталог SSH' },
  { re: /(^|\/)\.git\/(?!$)/i, what: 'внутренности git' },
];

/**
 * Команды, отклоняемые целиком. Проверяется по нормализованной строке, поэтому лишние
 * пробелы не помогают их пронести.
 */
const DENIED_BASH: { re: RegExp; what: string }[] = [
  { re: /\bgit\s+push\b[^\n]*--force(?!-with-lease)/, what: 'git push --force' },
  { re: /\bgit\s+push\b[^\n]*\s-f(\s|$)/, what: 'git push -f' },
  { re: /\bgit\s+reset\s+--hard\b/, what: 'git reset --hard' },
  { re: /\bgit\s+clean\s+-[a-z]*f/, what: 'git clean -f' },
  { re: /\brm\s+-[a-z]*r[a-z]*f|\brm\s+-[a-z]*f[a-z]*r/, what: 'rm -rf' },
  { re: /\bchmod\s+-R\b/, what: 'chmod -R' },
  { re: /\|\s*(sudo\s+)?(sh|bash)\b/, what: 'пайп в шелл' },
  { re: /\bcurl\b[^\n]*\|\s*\w*sh\b/, what: 'curl | sh' },
  { re: /\bsudo\b/, what: 'sudo' },
];

function normalizeCommand(cmd: string): string {
  return cmd.replace(/\s+/g, ' ').trim();
}

export function checkWritePath(relPath: string): PolicyVerdict {
  for (const { re, what } of DENIED_WRITE) {
    if (re.test(relPath)) {
      return policyDeny(
        'denyList',
        `запись в «${relPath}» отклонена: ${what}. Этот запрет не снимается настройкой этапа.`,
      );
    }
  }
  return POLICY_OK;
}

export function checkBash(command: string): PolicyVerdict {
  const normalized = normalizeCommand(command);
  for (const { re, what } of DENIED_BASH) {
    if (re.test(normalized)) {
      return policyDeny(
        'denyList',
        `команда отклонена: ${what}. Этот запрет не снимается настройкой этапа.`,
      );
    }
  }
  // Редирект в запрещённую категорию — та же запись, просто через шелл.
  for (const target of redirectTargets(command)) {
    const v = checkWritePath(target);
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
