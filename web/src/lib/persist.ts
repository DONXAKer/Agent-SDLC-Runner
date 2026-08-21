/**
 * Обёртки над localStorage, которые не бросают.
 *
 * Доступ к хранилищу падает в приватном режиме Safari и при отключённых данных сайта, а
 * границ ошибок в приложении нет — бросок из инициализатора useState увёл бы страницу в
 * белый экран. Предпочтения — удобство, их потеря допустима; падение — нет.
 */

/** Общий префикс, чтобы ключи страницы не столкнулись с чужими на том же origin. */
const NS = 'sdlc.web.';

export function readLS(key: string): string | null {
  try {
    return localStorage.getItem(NS + key);
  } catch {
    return null;
  }
}

export function writeLS(key: string, value: string): void {
  try {
    localStorage.setItem(NS + key, value);
  } catch {
    // Некуда писать — предпочтение просто не переживёт перезагрузку.
  }
}
