/** Разбор карты только по кандидатам, фактически переданным модели. */
export interface MapAnswer {
  path: string;
  now: string;
  change: string;
}

/** The no-op correction response may carry ordinary terminal punctuation. */
export function isNoExploreMapCorrection(text: string): boolean {
  return /^нет исправлений[.!…]*$/iu.test(text.trim());
}

export function parseExploreMap(text: string, candidates: readonly string[]) {
  const accepted = new Map<string, MapAnswer | null>();
  const rejected: string[] = [];
  const newFiles: Array<{ path: string; what: string }> = [];
  const ambiguous = new Set<string>();
  const clean = (s: string) => s.replace(/[`*]/g, '').trim();
  const safeNegativeTail = (parts: readonly string[]) => {
    const tail = parts.slice(1).map((part) => clean(part).replace(/[.!?]+$/u, '').trim()).filter(Boolean);
    return tail.every((part) => /^(?:нет|no|[-—–])$/iu.test(part)) ||
      (tail.length > 0 && /(?:не относится|не касается|вне задачи|не нужен|not relevant|out of scope)/iu.test(tail.join(' ')));
  };
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim() || /^\s*```/.test(line)) continue;
    // Some models preserve the semantic new-file marker but miss the `+ path | change`
    // syntax. Accept that explicit equivalent while still rejecting unmarked guesses.
    const markedNew = /^\s*(.+?)\s+\(\u043d\u043e\u0432\u044b\u0439\)\s*(?:[\/|\u2014\u2013-])\s*(.+)$/iu.exec(line);
    if (markedNew !== null) {
      const path = clean(markedNew[1]!);
      const what = markedNew[2]!.trim();
      if (!/^[\w./@-]+$/.test(path) || !(path.includes('/') || /\.[a-z0-9]{1,8}$/i.test(path)) || !what) {
        rejected.push(`неверный новый путь или пустое изменение: ${line}`);
      } else newFiles.push({ path, what });
      continue;
    }
    if (/^\s*\+/.test(line)) {
      const [rawPath = '', ...rest] = line.trim().slice(1).split('|');
      const path = clean(rawPath);
      const what = rest.join(' | ').trim();
      if (!/^[\w./@-]+$/.test(path) || !(path.includes('/') || /\.[a-z0-9]{1,8}$/i.test(path)) || !what || /^[—–-]$/.test(what)) {
        rejected.push(`неверный новый путь или пустое изменение: ${line}`);
      } else newFiles.push({ path, what });
      continue;
    }
    const match = /^\s*(\d+)[.)]\s*(.*)$/.exec(line);
    if (!match) { rejected.push(`неоднозначная строка: ${line}`); continue; }
    const parts = match[2]!.split('|').map((p) => p.trim());
    // The prompt's documented negative form is `N. нет.`; accept its terminal
    // punctuation before checking whether the candidate is out of scope.
    const head = clean(parts[0]!).replace(/[.!?]+$/u, '').trim();
    let path = candidates[Number(match[1]) - 1];
    let now = parts[1] ?? '';
    let change = parts.slice(2).join(' | ').trim();
    // A common compact answer names the candidate before a negative decision.
    // The path must still be exact: accepting a guessed path would hide a model error.
    const pathDecision = /^([^|:]+?)\s+[—–-]\s+(нет|no|да|yes)$/i.exec(head);
    if (pathDecision) {
      const named = clean(pathDecision[1]!);
      path = candidates.find((p) => p === named);
      if (!path) { rejected.push(`неизвестный путь: ${named}`); continue; }
      if (/^(нет|no)$/i.test(pathDecision[2]!)) {
        if (!safeNegativeTail(parts)) { rejected.push(`неоднозначное отрицание: ${line}`); continue; }
        if (accepted.has(path) || ambiguous.has(path)) { accepted.delete(path); ambiguous.add(path); rejected.push(`повторная строка для ${path}`); continue; }
        accepted.set(path, null);
        continue;
      }
      if (parts.length < 3) { rejected.push(`пустое описание или изменение: ${path}`); continue; }
      now = parts[1] ?? '';
      change = parts.slice(2).join(' | ').trim();
    }
    const no = /^(?:нет|no)$/i.test(head);
    if (!pathDecision && !no && !/^(?:да(?=\s|[—:,.!]|$)|yes\b)/i.test(head)) {
      const colon = head.indexOf(':');
      const named = colon < 0 ? head : head.slice(0, colon).trim();
      path = candidates.find((p) => p === named);
      if (!path) { rejected.push(`неизвестный путь: ${named}`); continue; }
      if (colon >= 0) {
        now = head.slice(colon + 1).trim();
        change = parts.slice(1).join(' | ').trim();
      }
    }
    if (!path) { rejected.push(`неизвестный номер: ${match[1]}`); continue; }
    if (!no && /^[\w./@-]+\.[a-z0-9]{1,8}$/i.test(clean(now))) {
      rejected.push(`вместо функций указан путь ${now}; ответь «номер. путь: функции | изменение»`); continue;
    }
    if (accepted.has(path) || ambiguous.has(path)) {
      accepted.delete(path);
      ambiguous.add(path);
      rejected.push(`повторная строка для ${path}`); continue;
    }
    // Small local models sometimes copy the three visible response columns even
    // for a negative row (`N. нет | нет | нет`). Treat that as one unambiguous
    // negative decision; any substantive text after `нет` remains rejected.
    if (no && !safeNegativeTail(parts)) {
      rejected.push(`неоднозначное отрицание: ${line}`); continue;
    }
    if (!no && (!now || !change || /^[—–-]$/.test(change))) {
      rejected.push(`пустое описание или изменение: ${path}`); continue;
    }
    accepted.set(path, no ? null : { path, now, change });
  }
  const missing = candidates.filter((p) => !accepted.has(p));
  return { accepted, missing, rejected, newFiles };
}
