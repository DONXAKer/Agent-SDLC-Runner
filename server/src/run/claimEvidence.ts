/**
 * Карта улик под ОДИН пункт приёмки: нарезка патча на хунки и отбор относящихся к пункту.
 *
 * Зачем. Этап 6 у дешёвой модели тонет не в сложности суждения, а в объёме: патч подаётся
 * целиком (потолок артефактов на verify намеренно снят — «лучше промпт не влез, чем вердикт
 * по трети правки»), и на окне 16K разбор одного пункта конкурирует за контекст со всеми
 * остальными. Поклаймовый добор задаёт по одному вопросу за раз, и каждому вопросу нужен
 * СВОЙ срез, а не весь патч.
 *
 * Чем это не «обрезка». Целый патч по-прежнему читает независимый рецензент — кросс-файловый
 * дефект, регрессия и сломанный инвариант видны только на нём. Срез существует для второго,
 * узкого вопроса: «чем подтверждается вот этот пункт», и заменять им проход по целому
 * патчу нельзя (см. план: находимость по посеву имеет право вето).
 *
 * Отбор — по совпадению слов пункта с текстом хунка, а не по «умной» эвристике: пункт
 * называет предметные слова («надбавка», «negабарит», `surcharge`), и они же стоят в коде
 * и в путях. Совпадений нет — отдаются первые хунки по порядку: пустая карта хуже
 * неточной, потому что она молча превращает вопрос в «ответь по памяти».
 */

export interface Hunk {
  /** Файл из заголовка `diff --git` — по нему же считается совпадение. */
  file: string;
  text: string;
}

const FILE_HEADER = /^diff --git a\/(.+?) b\/(.+)$/;

/**
 * Режет патч на куски «файл + его хунки».
 *
 * Границей служит `diff --git`, а не `@@`: хунк без шапки файла бесполезен — по нему
 * нельзя сказать, где правка, а «где» и есть половина ответа о доказательстве.
 */
export function splitHunks(diff: string): Hunk[] {
  const out: Hunk[] = [];
  let file: string | null = null;
  let buf: string[] = [];

  const flush = (): void => {
    if (file !== null && buf.length > 0) out.push({ file, text: buf.join('\n') });
    buf = [];
  };

  for (const line of diff.split('\n')) {
    const m = FILE_HEADER.exec(line.trim());
    if (m !== null) {
      flush();
      file = m[2] ?? m[1] ?? null;
    }
    buf.push(line);
  }
  flush();
  return out;
}

/** Значимые слова строки: короткие и числовые отбрасываются — они совпадают со всем. */
function tokens(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}_]+/u)
    .filter((t) => t.length >= 4 && !/^\d+$/.test(t));
}

/**
 * Карта улик под пункт: хунки, где встречаются его слова, в пределах байтового потолка.
 *
 * Потолок обязателен: у локального контура окно 16K, и «весь патч на каждый вопрос»
 * съедает его целиком ещё до того, как модель дочитает сам пункт.
 */
export function packForClaim(claimText: string, hunks: readonly Hunk[], budgetBytes: number): string {
  const words = new Set(tokens(claimText));
  const scored = hunks.map((h, i) => {
    const hit = new Set(tokens(`${h.file}\n${h.text}`));
    let score = 0;
    for (const w of words) if (hit.has(w)) score++;
    // Порядок в патче — вторичный ключ: при равном совпадении срез обязан быть
    // воспроизводимым, иначе один и тот же вход давал бы разные вопросы.
    return { h, score, i };
  });
  scored.sort((a, b) => b.score - a.score || a.i - b.i);

  const parts: string[] = [];
  let used = 0;
  for (const s of scored) {
    const size = Buffer.byteLength(s.h.text, 'utf8');
    if (used + size > budgetBytes && parts.length > 0) continue;
    parts.push(s.h.text);
    used += size;
  }
  return parts.join('\n\n');
}
