/**
 * Вывод команды для улики — отдельным модулем без зависимостей: его зовут и реестр
 * встроенных гейтов (`index.ts`), и сами гейты (`baseCheck.ts`), и прогон набора
 * (`run.ts`); жил бы он в `index.ts` — импорт гейта из реестра замыкал бы цикл модулей.
 */

/** Полный вывод команды для улики: stdout, затем stderr с меткой. */
export function fullOutputOf(stdout: string, stderr: string): string {
  return [
    ...(stdout.trim() === '' ? [] : [stdout]),
    ...(stderr.trim() === '' ? [] : [`--- stderr ---\n${stderr}`]),
  ].join('\n');
}

/** Хвост вывода для улики: последние строки, с потолком по байтам. */
export function outputTailOf(stdout: string, stderr: string, maxLines = 200, maxBytes = 20000): string {
  // Метка stderr ставится ПЕРЕД его содержимым и когда stdout пуст: иначе stderr читался
  // неотличимо от stdout, и улика молча выдавала диагностику за штатный вывод.
  const joined = fullOutputOf(stdout, stderr);
  const lines = joined.split(/\r?\n/);
  let tail = lines.slice(-maxLines).join('\n');
  let cutBytes = false;
  if (Buffer.byteLength(tail, 'utf8') > maxBytes) {
    tail = Buffer.from(tail, 'utf8').subarray(-maxBytes).toString('utf8');
    // Байтовый срез мог попасть в середину UTF-8-символа — обрывок в начале не текст.
    tail = tail.replace(/^�+/, '');
    cutBytes = true;
  }
  // Любая обрезка называется вслух: молча усечённая улика читается как полная, и
  // рецензент судит по неполному выводу, не зная об этом.
  const marks = [
    ...(lines.length > maxLines ? [`показаны последние ${maxLines} строк`] : []),
    ...(cutBytes ? [`хвост урезан до ${maxBytes} байт`] : []),
  ];
  return marks.length > 0 ? `[рантайм обрезал: ${marks.join('; ')}]\n${tail}` : tail;
}
