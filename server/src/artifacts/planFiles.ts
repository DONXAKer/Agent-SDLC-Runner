/**
 * Извлечение `files_to_touch` из плана.
 *
 * Этот список — вход PlanScope: ровно в эти файлы агенту разрешено писать на этапе 5.
 * Поэтому парсер ошибается в безопасную сторону — лучше не разрешить лишнего, чем
 * расширить allowlist на запись.
 *
 * Отдельно вырезается хвост секции начиная со строки «Из задачи исключено»: она
 * перечисляет пути, которые в `files_to_touch` **не входят**, и включение их в allowlist
 * разрешило бы правку в файле, который трогать не собирались, — ровно то, что методология
 * запрещает прямым текстом.
 */

const SECTION_RE = /^#{1,6}\s.*files_to_touch/im;
const NEXT_HEADING_RE = /^#{1,6}\s/m;
/** Строка, с которой начинается перечисление исключённых путей. */
const EXCLUDED_RE = /^.*Из задачи исключено/im;

/** Похоже ли на путь, а не на имя символа, команду или прозу. */
function looksLikePath(s: string): boolean {
  const t = s.trim().replace(/^`|`$/g, '').trim();
  if (t === '' || /\s/.test(t)) return false;
  if (t.includes('‹') || t.includes('›')) return false;
  if (!t.includes('/') && !t.includes('.')) return false;
  // `путь:символ` — форма из отчёта разведки, для записи не годится.
  if (t.includes('::')) return false;
  // Артефакты процесса в files_to_touch не пишутся и в сверке не участвуют.
  if (t === '.sdlc' || t.startsWith('.sdlc/')) return false;
  return true;
}

function clean(s: string): string {
  return s.trim().replace(/^`|`$/g, '').trim();
}

export function extractFilesToTouch(planText: string): string[] {
  const start = SECTION_RE.exec(planText);
  if (start === null) return [];

  const rest = planText.slice(start.index + start[0].length);
  const next = NEXT_HEADING_RE.exec(rest);
  let section = next === null ? rest : rest.slice(0, next.index);

  const excluded = EXCLUDED_RE.exec(section);
  if (excluded !== null) section = section.slice(0, excluded.index);

  const out: string[] = [];
  const add = (raw: string): void => {
    const t = clean(raw);
    if (looksLikePath(t) && !out.includes(t)) out.push(t);
  };

  for (const line of section.split('\n')) {
    const trimmed = line.trim();

    // Строка таблицы: первая ячейка — путь. Разделитель «|---|---|» пропускаем.
    if (trimmed.startsWith('|') && !/^\|[\s|:-]+\|?$/.test(trimmed)) {
      const cells = trimmed.split('|').map((c) => c.trim());
      const first = cells.find((c) => c !== '');
      if (first !== undefined) add(first);
      continue;
    }

    // Вне таблицы берём только пути в обратных кавычках — проза в allowlist не попадает.
    const re = /`([^`\n]+)`/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(line)) !== null) add(m[1] ?? '');
  }

  return out;
}
