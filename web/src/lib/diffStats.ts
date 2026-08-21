/**
 * Разбор сводного патча по файлам — для пофайлового просмотра в компактном режиме.
 *
 * Парсится стандартный вывод `git diff`. Путь берётся из `b/`-стороны заголовка: она
 * называет файл после правки, в том числе при переименовании. Пути со спецсимволами git
 * заключает в кавычки — обе формы поддержаны.
 */

export interface FileDiff {
  path: string;
  adds: number;
  dels: number;
  /** Полный текст диффа этого файла, включая заголовок. */
  text: string;
}

const HEADER = /^diff --git (?:"a\/.*?"|a\/.*?) (?:"b\/(.*)"|b\/(.*))$/;

export function splitPatchByFile(patch: string): FileDiff[] {
  const out: FileDiff[] = [];
  let current: { path: string; adds: number; dels: number; lines: string[] } | null = null;

  const push = (): void => {
    if (current !== null) {
      out.push({
        path: current.path,
        adds: current.adds,
        dels: current.dels,
        text: current.lines.join('\n'),
      });
    }
  };

  for (const line of patch.split('\n')) {
    const m = HEADER.exec(line);
    if (m !== null) {
      push();
      current = { path: m[1] ?? m[2] ?? '', adds: 0, dels: 0, lines: [] };
    }
    if (current === null) continue;
    current.lines.push(line);
    // `+++`/`---` — заголовки файла, а не изменённые строки.
    if (line.startsWith('+') && !line.startsWith('+++')) current.adds++;
    if (line.startsWith('-') && !line.startsWith('---')) current.dels++;
  }
  push();
  return out;
}

export interface FileDiffWithPlan extends FileDiff {
  inPlan: boolean;
}

/**
 * Соединить разобранный патч с серверной разметкой «в плане / вне плана» и поднять файлы
 * вне плана наверх: запись туда либо не проходит политику, либо вменяется исполнителю
 * scope-гейтом — увидеть это лучше первым делом.
 *
 * Файл, которого нет в серверном списке, не теряется и считается вне плана — по худшему
 * случаю, как и всё незнакомое в этой кодовой базе.
 */
export function orderFiles(
  parsed: FileDiff[],
  files: { path: string; inPlan: boolean }[],
): FileDiffWithPlan[] {
  const inPlanBy = new Map(files.map((f) => [f.path, f.inPlan]));
  const all = parsed.map((f) => ({ ...f, inPlan: inPlanBy.get(f.path) ?? false }));
  return [...all.filter((f) => !f.inPlan), ...all.filter((f) => f.inPlan)];
}
