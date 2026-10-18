/**
 * Строки подтверждения перезаписи в журнале chunk'а — секция «## Перезапись файлов»,
 * форма `путь — почему перезапись законна — подтвердил имя · дата` (`SDLC.md` → гейт
 * «Перезапись файла»). Один разбор на гейт (`gates/builtin/overwrite.ts`) и на гард
 * фабрикации (`approval/humanDecision.ts`): подтверждение — решение человека, и строка с
 * именем, появившаяся после записи модели, — та же фабрикация, что имя в поле «Подтвердил».
 */

const PLACEHOLDER = /‹|›/;

export interface OverwriteConfirmation {
  path: string;
  why: string;
  signedBy: string;
}

export function overwriteConfirmations(journal: string): OverwriteConfirmation[] {
  const lines = journal.split(/\r?\n/);
  const start = lines.findIndex((l) => /^##\s+Перезапись файлов\s*$/i.test(l.trim()));
  if (start < 0) return [];
  const out: OverwriteConfirmation[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    const t = lines[i]!.trim();
    if (/^##\s/.test(t)) break;
    if (!t.startsWith('-')) continue;
    const body = t.replace(/^[-*]\s*/, '');
    // `\b` по кириллице не работает — граница явным символом.
    if (/^н\/п(\s|$|[—–-])/i.test(body)) continue;
    const parts = body.split(/\s+—\s+/);
    if (parts.length < 3) continue;
    const signed = parts.slice(2).join(' — ');
    const m = /подтвердил[аи]?\s+(.+)$/iu.exec(signed);
    if (m === null) continue;
    const name = m[1]!.split('·')[0]!.trim();
    if (name === '' || PLACEHOLDER.test(name)) continue;
    out.push({ path: parts[0]!.replace(/`/g, '').trim().replace(/\\/g, '/'), why: parts[1]!.trim(), signedBy: name });
  }
  return out;
}

/** Есть ли в тексте секция подтверждений перезаписи (форма журнала chunk'а). */
export function hasOverwriteSection(text: string): boolean {
  return /^##\s+Перезапись файлов\s*$/imu.test(text);
}
