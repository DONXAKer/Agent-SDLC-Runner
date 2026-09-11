/**
 * Карточки для вопросов конвейера `exploreFill` и для слепого вывода листа: срез файла с
 * пометкой обрезки — тот же приём, что у карточки шага в `StepExecutor` и среза патча под
 * пункт в `claimEvidence.ts`. Чистые функции, потолки в байтах.
 */

import { capBytes } from '../prompt/bytes.ts';
import type { IndexedFile, SymbolDecl } from './types.ts';

const CUT_NOTE = '…[обрезано рантаймом: файл длиннее потолка карточки]';

/** Байт разделителя между карточками — тот же, что `packCards` вставляет между ними. */
const CARD_SEPARATOR_BYTES = 2;
/** Пол размера карточки — ниже него срез теряет смысл (пустая шапка почти съедает бюджет). */
const MIN_CARD_BYTES = 600;

/**
 * Потолок ОДНОЙ карточки при упаковке `n` карточек в общий бюджет `packCards`'ом — общее
 * место для `ExploreExecutor` и `Run.runClaimsBlind`, которые считали одну и ту же формулу
 * раздельно (ревью code-review-all, 2026-09-11). Резервирует байты под `(n-1)` разделителей
 * ЗАРАНЕЕ: без этого `n` карточек, обрезанных ровно по прежнему потолку, суммарно требовали
 * `n·potolok + (n-1)·2` байт — на пороге бюджета `packCards` отбрасывал последнюю карточку
 * без единой содержательной причины (подтверждено прогоном).
 */
export function cardBudgetPerFile(totalBudgetBytes: number, count: number): number {
  if (count <= 0) return totalBudgetBytes;
  return Math.max(MIN_CARD_BYTES, Math.floor((totalBudgetBytes - CARD_SEPARATOR_BYTES * (count - 1)) / count));
}

/** Шапка файла: путь, размер, символы и начало текста под потолок. */
export function fileCard(file: IndexedFile, maxBytes: number): string {
  const head = [
    `### \`${file.path}\` — ${file.lines} строк, ${file.kind === 'test' ? 'тест' : 'код'}`,
    `символы: ${file.symbols.length === 0 ? '(разбор не нашёл)' : file.symbols.map((s) => s.name).join(', ')}`,
    '```',
  ].join('\n');
  const tail = '\n```';
  const budget = Math.max(0, maxBytes - Buffer.byteLength(`${head}\n${tail}\n${CUT_NOTE}`, 'utf8'));
  const body = capBytes(file.text, budget);
  return `${head}\n${body.text}${body.capped ? `\n${CUT_NOTE}` : ''}${tail}`;
}

/** Строки вокруг объявления символа — для вопроса «переиспользуем?». */
export function symbolCard(file: IndexedFile, s: SymbolDecl, context = 25): string {
  const lines = file.text.split(/\r?\n/);
  const from = Math.max(0, s.line - 1 - Math.floor(context / 5));
  const to = Math.min(lines.length, s.line - 1 + context);
  return [`### \`${file.path}:${s.name}\` (строка ${s.line})`, '```', ...lines.slice(from, to), '```'].join('\n');
}

/**
 * Склейка карточек под общий потолок: карточка, не влезающая целиком, отбрасывается, и
 * это сказано в хвосте — модель знает, что кандидаты ниже ей не показаны.
 */
export function packCards(cards: readonly string[], budgetBytes: number): string {
  const out: string[] = [];
  let left = budgetBytes;
  let dropped = 0;
  for (const c of cards) {
    // Разделитель `\n\n` (2 байта) нужен только МЕЖДУ карточками — первая ничего не
    // стоит сверх своего размера. Прежний счёт брал +2 и для первой карточки тоже: при
    // N карточках ровно на потолке это переплата в N байт, которой хватало, чтобы
    // последняя карточка не влезла без единой содержательной причины (ревью
    // code-review-all, 2026-09-11, воспроизведено прогоном).
    const size = Buffer.byteLength(c, 'utf8') + (out.length > 0 ? 2 : 0);
    if (size > left) {
      dropped++;
      continue;
    }
    out.push(c);
    left -= size;
  }
  if (dropped > 0) out.push(`…[${dropped} карточек не показаны: потолок ${budgetBytes} байт]`);
  return out.join('\n\n');
}
