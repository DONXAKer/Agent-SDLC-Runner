/**
 * Разрезать сводный патч на блоки по файлам — только для пофайлового просмотра текста.
 *
 * Путь, «в плане» и счётчики строк сюда НЕ парсятся: их уже посчитал сервер тем же
 * разбором, что и весь остальной unified diff в кодовой базе (`server/src/diff/parse.ts`,
 * «один на всю кодовую базу»). Клиентский парсер путей здесь был вторым, рукописным, и
 * расходился с серверным на квотированных путях и на путях с ` b/` внутри — ровно тот
 * дефект, который канонический разбор уже устранял на сервере. Поэтому граница между
 * файлами режется по строке `diff --git ` (в валидном unified diff строка тела ВСЕГДА
 * начинается с ' ', '+', '-' или '\', так что голая `diff --git ` в начале строки может
 * быть только заголовком — здесь это разрез, а не разбор содержимого), а сами блоки
 * сопоставляются с уже готовым, серверным списком файлов по порядку появления.
 */
export function splitPatchBlocks(patch: string): string[] {
  if (patch === '') return [];
  const blocks: string[] = [];
  let current: string[] | null = null;
  for (const line of patch.split('\n')) {
    if (line.startsWith('diff --git ')) {
      if (current !== null) blocks.push(current.join('\n'));
      current = [line];
    } else if (current !== null) {
      current.push(line);
    }
  }
  if (current !== null) blocks.push(current.join('\n'));
  return blocks;
}

export interface FileDiffWithPlan {
  path: string;
  inPlan: boolean;
  adds: number;
  dels: number;
  text: string;
}

/**
 * Сопоставить серверный список файлов (путь, «в плане», счётчики) с текстом блоков и
 * поднять файлы вне плана наверх: запись туда либо не проходит политику, либо вменяется
 * исполнителю scope-гейтом — увидеть это лучше первым делом.
 *
 * Порядок блоков в патче совпадает с порядком `files` (оба — «в порядке первого
 * появления» одного и того же текста), поэтому сопоставление позиционное, а не по строке.
 */
export function orderFiles(
  files: { path: string; inPlan: boolean; adds: number; dels: number }[],
  patch: string,
): FileDiffWithPlan[] {
  const blocks = splitPatchBlocks(patch);
  const withText = files.map((f, i) => ({ ...f, text: blocks[i] ?? '' }));
  return [...withText.filter((f) => !f.inPlan), ...withText.filter((f) => f.inPlan)];
}
