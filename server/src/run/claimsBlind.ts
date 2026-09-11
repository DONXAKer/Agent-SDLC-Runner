/**
 * Слепой вывод приёмочного листа (агент 2 этапа 2, `sdlc-claims`) — прогоном РАНТАЙМА, а
 * не вызовом `Task` из хода модели. Тот же приём, что `runReviewerDirectly` для рецензента:
 * методология требует независимого исполнителя там, где судящий не должен быть автором,
 * а модель, которая не зовёт даже `Read`, до `Task` не доходит тем более.
 *
 * Слепота — ВХОДОМ, а не просьбой. Определение агента (`sdlc-claims.md`) запрещает
 * открывать `.sdlc/` инструкцией; здесь инструментов нет вовсе: на вход идут четыре секции
 * задачи («Коротко», «Зачем», «Что делаем», «Чего не делаем»), индекс проекта и карточки
 * файлов-кандидатов — в индексе `.sdlc` отсутствует по построению (`explore/tree.ts`).
 * Ни пути к `intent.md`, ни авторского листа, ни «Что придётся тронуть» в промпте нет —
 * это проверяется тестом на составе сообщений, а не чтением промпта.
 *
 * Цена решения названа: у агента нет `Read`/`Grep`, и файл вне карточек он не увидит.
 * Вариант с инструментами требует префиксного `readDenied` в политике и исключения `.sdlc`
 * из `grepTool` — отдельная волна, см. `docs/stage-tooling.md`.
 */

import type { Usage } from '@sdlc-runner/shared';

import { h2SectionRanges } from '../md/table.ts';
import { ProviderEnvError, type ChatProvider } from '../provider/ChatProvider.ts';

export interface BlindSections {
  brief: string;
  why: string;
  doing: string;
  notDoing: string;
}

export interface BlindClaimsInput {
  provider: ChatProvider;
  model: string;
  params: Record<string, unknown> | null;
  /** Тело определения `sdlc-claims.md` — его системный промпт, не копия текста. */
  system: string;
  sections: BlindSections;
  /** Блок индекса проекта — тот же, что уходит основному ходу. */
  indexBlock: string;
  /** Карточки файлов-кандидатов под потолок байт. */
  sources: string;
  signal: AbortSignal;
  onProgress?: (note: string) => void;
  onUsage?: (usage: Usage) => void;
}

export interface BlindClaim {
  n: number;
  text: string;
  check: string;
  tags: ('edge' | 'manual')[];
}

export interface BlindClaimsResult {
  claims: BlindClaim[];
  raw: string;
  envFailure: string | null;
  /**
   * Запрос не состоялся по причине, отличной от среды (сеть, таймаут, отказ провайдера).
   * Отдельно от `envFailure`: тот уводит гейт этапа в специальный отказ (`ProviderEnvError`
   * наверху), этот — обычная неудача попытки. Без разделения пустой `claims` при упавшем
   * запросе неотличим от честного «субагент вернул пустой лист» — вызывающий писал бы в
   * отчёт утверждение о проведённом сравнении, которого не было (ревью code-review-all,
   * 2026-09-11).
   */
  requestError: string | null;
}

/** Строка секции без заголовка, цитат шапки и курсивных легенд. */
function sectionBody(text: string, title: RegExp): string | null {
  const range = h2SectionRanges(text, title)[0];
  if (range === undefined) return null;
  const lines = text.slice(range.start, range.end).split(/\r?\n/).slice(1);
  return lines
    .filter((l) => !l.trim().startsWith('>') && !/^_.*_$/.test(l.trim()))
    .join('\n')
    .trim();
}

/**
 * Четыре секции задачи для слепого агента. `null` — задача не по форме (нет хотя бы
 * «Коротко» или «Что делаем»): слепой вывод без цели невозможен, и это отказ, а не пустой лист.
 */
export function intentSectionsForBlind(intentText: string): BlindSections | null {
  const brief = sectionBody(intentText, /^коротко$/i);
  const doing = sectionBody(intentText, /^что делаем$/i);
  if (brief === null || doing === null) return null;
  return {
    brief,
    why: sectionBody(intentText, /^зачем$/i) ?? '',
    doing,
    notDoing: sectionBody(intentText, /^чего не делаем$/i) ?? '',
  };
}

export function blindClaimsQuestion(i: BlindClaimsInput): string {
  return [
    '## Задача (четыре секции — больше из неё тебе не показывают намеренно)',
    '',
    '### Коротко',
    i.sections.brief,
    '',
    '### Зачем',
    i.sections.why === '' ? '(не заполнено)' : i.sections.why,
    '',
    '### Что делаем',
    i.sections.doing,
    '',
    '### Чего не делаем',
    i.sections.notDoing === '' ? '(не заполнено)' : i.sections.notDoing,
    '',
    '## Индекс проекта (собран рантаймом)',
    '',
    i.indexBlock,
    '',
    '## Исходники файлов-кандидатов',
    '',
    i.sources,
    '',
    '## Что вернуть',
    '',
    'Выведи приёмочный лист ОТ НУЛЯ по этим секциям и коду. Одна строка на пункт, строго в форме:',
    '',
    '`N. что наблюдаем | как проверить (процедура + критерий годности)`',
    '',
    'Граничные и негативные случаи помечай `[edge]` в первой части, ручные — `[manual]`. ' +
      'Никаких заголовков, пояснений и таблиц — только пронумерованные строки.',
  ].join('\n');
}

const LINE_RE = /^\s*(?:(\d+)[.)]|[-*•])\s+(.*)$/;

/** Разбор строк «N. пункт | как проверить». Строки не по форме пропускаются, дубли номеров тоже. */
export function parseBlindClaims(text: string): BlindClaim[] {
  const numbered: BlindClaim[] = [];
  const bulleted: Omit<BlindClaim, 'n'>[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const m = LINE_RE.exec(raw);
    if (m === null) continue;
    const rest = (m[2] ?? '').trim();
    if (rest === '' || rest.startsWith('|') || rest.startsWith('```')) continue;
    const parts = rest.split('|').map((p) => p.trim());
    const head = parts[0] ?? '';
    const check = parts.slice(1).join(' | ').trim();
    const tags: ('edge' | 'manual')[] = [];
    if (/\[edge\]/i.test(rest)) tags.push('edge');
    if (/\[manual\]/i.test(rest)) tags.push('manual');
    const textClean = head.replace(/\[(edge|manual)\]/gi, '').replace(/\s+/g, ' ').trim();
    if (textClean === '') continue;
    const cleanCheck = check.replace(/\[(edge|manual)\]/gi, '').trim();
    if (m[1] === undefined) bulleted.push({ text: textClean, check: cleanCheck, tags });
    else numbered.push({ n: Number(m[1]), text: textClean, check: cleanCheck, tags });
  }
  const out: BlindClaim[] = [];
  const seen = new Set<number>();
  for (const c of numbered) {
    if (seen.has(c.n)) continue;
    seen.add(c.n);
    out.push(c);
  }
  // Строка списком вместо номера (преамбула вида «- вот лист:» перед настоящим «1. …», или
  // хвостовая «- ручная проверка») нумеруется ПОСЛЕ всех явно пронумерованных строк, а не по
  // порядку появления в тексте: иначе случайная преамбула забирала бы номер 1 у настоящего
  // первого пункта, и он терялся бы как «дубль» (ревью code-review-all, 2026-09-11).
  let next = numbered.reduce((m, c) => Math.max(m, c.n), 0) + 1;
  for (const c of bulleted) {
    while (seen.has(next)) next++;
    seen.add(next);
    out.push({ n: next, ...c });
    next++;
  }
  return out;
}

export async function deriveClaimsBlind(i: BlindClaimsInput): Promise<BlindClaimsResult> {
  let response: Awaited<ReturnType<ChatProvider['chat']>>;
  try {
    response = await i.provider.chat({
      model: i.model,
      messages: [
        { role: 'system', content: i.system },
        { role: 'user', content: blindClaimsQuestion(i) },
      ],
      tools: [],
      signal: i.signal,
      temperature: null,
      params: i.params,
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    const envFailure = e instanceof ProviderEnvError ? e.message : null;
    i.onProgress?.(`слепой вывод листа не состоялся: ${message}`);
    return { claims: [], raw: '', envFailure, requestError: envFailure === null ? message : null };
  }
  i.onUsage?.(response.usage);
  const claims = parseBlindClaims(response.text);
  i.onProgress?.(`слепой вывод листа: ${claims.length} пунктов, из них [edge] ${claims.filter((c) => c.tags.includes('edge')).length}`);
  return { claims, raw: response.text, envFailure: null, requestError: null };
}
