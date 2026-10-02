/**
 * Ключевые слова задачи — то, по чему индекс ранжирует файлы-кандидаты.
 *
 * Источники: заголовок, «Коротко», «Что делаем», «Что придётся тронуть»
 * (если уже заполнена). Легенды шаблона и плейсхолдеры `‹…›` не читаются: слова бланка
 * совпали бы с чем угодно. Токен в бэктиках — самый сильный сигнал (автор задачи назвал
 * путь или символ буквально), он классифицируется первым; прочие слова идут через
 * `significantTokens` — ту же меру значимости, что у среза патча под пункт приёмки.
 *
 * «Приёмочный лист» СЮДА не входит намеренно: `why`-строки ранжирования (`explore/rank.ts`)
 * уходят в блок индекса, а блок индекса — часть входа слепого агента `sdlc-claims`
 * (`run/claimsBlind.ts`). Слова из авторского листа в `why` были бы утечкой ровно того, от
 * чего слепота построена входом — агент увидел бы отпечаток чужого ответа раньше своего
 * (ревью code-review-all, 2026-09-11).
 */

import { PLACEHOLDER_RE } from '../artifacts/artifact.ts';
import { significantTokens } from '../run/claimEvidence.ts';

export interface Keywords {
  /** Пути и имена файлов из текста задачи (`src/tariffs.ts`, `discounts.ts`). */
  paths: string[];
  /** Идентификаторы кода (`priceFor`, `CAP_PCT`, `weightStep`). */
  symbols: string[];
  /** Прочие значимые слова, в нижнем регистре. */
  words: string[];
}

const SECTION_RE = /коротко|зачем|что делаем|что прид[её]тся тронуть/i;
const PATH_RE = /^[\w./@-]*(?:\/[\w.@-]+|\.[a-z0-9]{1,8})$/i;
const IDENT_RE = /^[A-Za-z_$][\w$]*$/;

/**
 * Слова бланка и методологии, которые попадают в любую задачу и ничего не ранжируют.
 * Список короткий намеренно: он режет только то, что видно в каждом intent.md.
 */
const STOP = new Set([
  'claim', 'edge', 'manual', 'должно', 'должен', 'должна', 'должны', 'нужно', 'нужен', 'нужна',
  'чтобы', 'который', 'которая', 'которые', 'этого', 'этой', 'этом', 'через', 'после', 'перед',
  'только', 'также', 'тоже', 'если', 'когда', 'иначе', 'проверить', 'проверка', 'тест', 'тесты',
  'команда', 'командой', 'файл', 'файле', 'файлы', 'функция', 'функции', 'модуль', 'модулем',
  'результат', 'значение', 'равен', 'равна', 'ровно', 'целиком', 'существующие', 'существующий',
  'правило', 'правила', 'изменений', 'менять', 'остаются', 'остаётся', 'остается', 'ничего',
]);

/**
 * Секции intent.md, по которым считаются слова: заголовок h1 + названные h2. Документ без
 * единой известной секции (задача в свободной форме, как `task.md` стенда) читается целиком —
 * иначе ключевых слов не было бы вовсе, и ранжирование молчало бы на честном входе.
 */
function relevantText(intentText: string): string {
  const lines = intentText.split(/\r?\n/);
  const hasKnownSection = lines.some((l) => {
    const h2 = /^##\s+(.+)$/.exec(l);
    return h2 !== null && SECTION_RE.test(h2[1] ?? '');
  });
  const out: string[] = [];
  let take = true; // до первого h2 — заголовок и шапка
  for (const line of lines) {
    const h2 = /^##\s+(.+)$/.exec(line);
    if (h2 !== null) {
      take = !hasKnownSection || SECTION_RE.test(h2[1] ?? '');
      continue;
    }
    if (!take) continue;
    if (line.trim().startsWith('>') || /^_.*_$/.test(line.trim())) continue; // цитата шапки, легенда
    out.push(line.replace(new RegExp(PLACEHOLDER_RE.source, 'g'), ' '));
  }
  return out.join('\n');
}

function looksLikeSymbol(token: string): boolean {
  if (!IDENT_RE.test(token)) return false;
  // camelCase, UPPER_CASE, snake_case или явно «кодовое» имя из бэктиков — не голое слово.
  return /[a-z][A-Z]|_|^[A-Z][A-Z0-9_]+$/.test(token) || /^[A-Z][a-z]+[A-Z]/.test(token);
}

export function intentKeywords(intentText: string, originalRequest = ''): Keywords {
  const text = relevantText(intentText);
  const paths = new Set<string>();
  const symbols = new Set<string>();
  const words = new Set<string>();

  // 1. Бэктики — буквальные имена.
  for (const m of text.matchAll(/`([^`\n]+)`/g)) {
    const raw = (m[1] ?? '').trim();
    // «`priceFor` (`src/tariffs.ts`)» — внутри бэктиков бывает вызов или путь с хвостом.
    const token = raw.replace(/\(.*$/, '').replace(/[:#].*$/, '').trim();
    if (token === '') continue;
    if (PATH_RE.test(token) && (token.includes('/') || /\.[a-z0-9]{1,8}$/i.test(token))) {
      paths.add(token.replace(/^\.\//, ''));
      continue;
    }
    if (IDENT_RE.test(token)) {
      symbols.add(token);
      continue;
    }
    for (const w of significantTokens(token)) words.add(w);
  }

  // 2. Голый текст: идентификаторы кода и значимые слова.
  const stripped = text.replace(/`[^`\n]+`/g, ' ');
  for (const m of stripped.matchAll(/[A-Za-z_$][\w$./-]*/g)) {
    // Знак конца предложения не отрывается символьным классом токена (`.` в него входит
    // ради расширения файла) — «правим src/tariffs.ts.» без этой чистки давал бы путь с
    // хвостовой точкой, не совпадающий ни с одним файлом индекса (ревью code-review-all,
    // 2026-09-11). Путь/идентификатор такими символами не заканчивается никогда.
    const token = m[0]!.replace(/[.,;:!?)\]}]+$/, '');
    if (token === '') continue;
    if (PATH_RE.test(token) && (token.includes('/') || /\.(ts|js|py|go|rs|java|kt|rb|php|cs|swift|md|json)$/i.test(token))) {
      paths.add(token.replace(/^\.\//, ''));
      continue;
    }
    if (looksLikeSymbol(token)) symbols.add(token);
  }
  // The author may name a required source in the original request that the first
  // interpretation omitted. Keep those paths as evidence candidates so exploration can
  // check the requirement against code before the plan is prepared.
  const explicitlyOutOfScope = new Set<string>();
  for (const line of originalRequest.split(/\r?\n/u)) {
    for (const m of line.matchAll(/(?:\.\.?\/)?[\w@.-]+(?:\/[\w@.-]+)*\.[A-Za-z0-9]{1,8}/g)) {
      const context = line.slice(Math.max(0, m.index! - 80), Math.min(line.length, m.index! + m[0]!.length + 80));
      if (!/(?:не[\s\S]{0,80}(?:трога|меня|прав|измен|touch|edit)|(?:трога|меня|прав|измен)[\s\S]{0,80}не\s+(?:трог|мен|прав|измен|touch|edit))/iu.test(context)) continue;
      explicitlyOutOfScope.add(m[0]!.replace(/^\.\//, '').replace(/[.,;:!?)\]}]+$/, '').toLocaleLowerCase('en-US'));
    }
  }
  for (const m of originalRequest.matchAll(/(?:\.\.?\/)?[\w@.-]+(?:\/[\w@.-]+)*\.[A-Za-z0-9]{1,8}/g)) {
    const path = m[0]!.replace(/^\.\//, '').replace(/[.,;:!?)\]}]+$/, '');
    if (explicitlyOutOfScope.has(path.toLocaleLowerCase('en-US'))) continue;
    if (PATH_RE.test(path) && path.includes('/')) paths.add(path);
  }
  for (const w of significantTokens(stripped)) {
    if (STOP.has(w)) continue;
    if ([...symbols].some((s) => s.toLowerCase() === w)) continue;
    words.add(w);
  }

  return { paths: [...paths], symbols: [...symbols], words: [...words] };
}
