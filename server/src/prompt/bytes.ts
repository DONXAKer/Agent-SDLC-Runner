/**
 * Обрезка текста по БАЙТАМ с выравниванием по границе символа.
 *
 * Байты, не `length`: кириллица в UTF-8 — 2 байта на символ, и посимвольный потолок
 * пропускал вдвое больше задуманного (тот же урок, что у `cap()` в exec/tools). Живёт
 * отдельным модулем, а не в `build.ts`: его зовут и сборщик промпта, и индекс разведки
 * (`explore/render.ts`, `explore/cards.ts`), а `build.ts` сам импортирует индекс — цикл.
 */
export function capBytes(text: string, maxBytes: number): { text: string; capped: boolean } {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return { text, capped: false };
  let cut = text.slice(0, maxBytes); // символов не больше, чем байтов — стартовая оценка сверху
  while (Buffer.byteLength(cut, 'utf8') > maxBytes) {
    cut = cut.slice(0, Math.floor((cut.length * maxBytes) / Buffer.byteLength(cut, 'utf8')));
  }
  // Граница может лечь между половинками суррогатной пары (астральный символ, «🚀»):
  // одиночный старший суррогат в конце строки — невалидный UTF-16, при кодировании в
  // UTF-8 превращается в U+FFFD и не проходит обратно round-trip (ревью code-review-all,
  // 2026-09-11, подтверждено прогоном). Символ целиком отрезается, а не «чинится».
  const lastCode = cut.charCodeAt(cut.length - 1);
  if (lastCode >= 0xd800 && lastCode <= 0xdbff) cut = cut.slice(0, -1);
  return { text: cut, capped: true };
}
