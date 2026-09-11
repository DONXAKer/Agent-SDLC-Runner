/**
 * Слепой вывод приёмочного листа рантаймом (`run/claimsBlind.ts`).
 *
 * Главная планка — слепота ВХОДОМ: в сообщениях провайдеру нет ни `claim-`, ни авторского
 * листа, ни «Что придётся тронуть», ни пути к `intent.md`. Плюс разбор форм ответа и отказ
 * среды признаком, а не текстом.
 */

import { deepStrictEqual, ok, strictEqual } from 'node:assert/strict';
import { describe, it } from 'node:test';

import { blindClaimsQuestion, deriveClaimsBlind, intentSectionsForBlind, parseBlindClaims } from '../src/run/claimsBlind.ts';
import { ProviderEnvError, type ChatProvider, type ChatRequest } from '../src/provider/ChatProvider.ts';

const INTENT = [
  '# Задача: демо',
  '',
  '## Коротко',
  '_легенда_',
  'бесплатная доставка для gold в ступени 3',
  '',
  '## Зачем',
  'маржа',
  '',
  '## Что делаем',
  '- льгота отдельным модулем',
  '',
  '## Чего не делаем',
  '- не трогаем `discountFor`',
  '',
  '## Приёмочный лист',
  '| id | Пункт | Как проверить |',
  '|---|---|---|',
  '| claim-1 | total равен 0 | тест |',
  '',
  '## Что придётся тронуть',
  '- src/tariffs.ts — правим',
  '',
].join('\n');

function provider(text: string, seen: ChatRequest[]): ChatProvider {
  return {
    name: 'stub',
    async chat(req: ChatRequest) {
      seen.push(req);
      return {
        text,
        toolCalls: [],
        usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: null, durationMs: 1 },
        finishReason: 'end_turn' as const,
      };
    },
  } as unknown as ChatProvider;
}

const sections = intentSectionsForBlind(INTENT)!;

describe('секции задачи для слепого агента', () => {
  it('берутся четыре секции без легенд; без «Коротко»/«Что делаем» — null', () => {
    strictEqual(sections.brief, 'бесплатная доставка для gold в ступени 3');
    strictEqual(sections.doing, '- льгота отдельным модулем');
    strictEqual(sections.notDoing, '- не трогаем `discountFor`');
    strictEqual(intentSectionsForBlind('# Задача\n\n## Зачем\nx\n'), null);
  });
});

describe('разбор листа', () => {
  it('формы «N. пункт | как проверить», теги, мусор вокруг, дубли номеров', () => {
    const claims = parseBlindClaims(
      ['Вот лист:', '1. total равен 0 [edge] | прогнать тест', '2) discount равен base | сравнить поля', '2. дубль | нет', '```', '- ручная проверка [manual] | глазами', ''].join('\n'),
    );
    strictEqual(claims.length, 3);
    deepStrictEqual(claims[0], { n: 1, text: 'total равен 0', check: 'прогнать тест', tags: ['edge'] });
    strictEqual(claims[1]!.n, 2);
    deepStrictEqual(claims[2]!.tags, ['manual']);
  });

  it('пустой ответ — пустой лист', () => {
    deepStrictEqual(parseBlindClaims(''), []);
  });

  it('строка-преамбула списком перед «1. …» не отнимает номер у настоящего первого пункта', () => {
    const claims = parseBlindClaims(
      ['- Вот приёмочный лист:', '1. total равен 0 | прогнать тест', '2. discount равен base | сравнить поля', ''].join('\n'),
    );
    strictEqual(claims.length, 3, claims.map((c) => `${c.n}:${c.text}`).join(', '));
    ok(claims.some((c) => c.n === 1 && c.text === 'total равен 0'), 'настоящий пункт 1 потерян');
    ok(claims.some((c) => c.n === 2 && c.text === 'discount равен base'), 'настоящий пункт 2 потерян');
    ok(claims.some((c) => c.text === 'Вот приёмочный лист:'), 'преамбула не получила отдельный номер');
  });
});

describe('слепота входом', () => {
  it('в сообщениях нет авторского листа, «Что придётся тронуть» и пути к intent.md', async () => {
    const seen: ChatRequest[] = [];
    const res = await deriveClaimsBlind({
      provider: provider('1. доставка бесплатна | тест', seen),
      model: 'm',
      params: null,
      system: 'ты слепой агент',
      sections,
      indexBlock: '### Дерево\n- `src/tariffs.ts` (157)',
      sources: '### `src/tariffs.ts`\n```\ncode\n```',
      signal: new AbortController().signal,
    });
    strictEqual(res.claims.length, 1);
    const all = seen.flatMap((r) => r.messages.map((m) => m.content)).join('\n');
    ok(!/claim-/i.test(all), 'авторский id утёк в промпт');
    ok(!/total равен 0/.test(all), 'авторский пункт утёк в промпт');
    ok(!/придётся тронуть|придется тронуть/i.test(all), '«Что придётся тронуть» утекло');
    ok(!/intent\.md/.test(all), 'путь к задаче утёк');
    ok(all.includes('бесплатная доставка'), 'секция «Коротко» не передана');
    ok(all.includes('src/tariffs.ts'), 'индекс не передан');
    strictEqual(seen[0]!.tools.length, 0, 'инструменты выданы');
  });

  it('вопрос называет форму строки и теги', () => {
    const q = blindClaimsQuestion({
      provider: provider('', []),
      model: 'm',
      params: null,
      system: '',
      sections,
      indexBlock: '',
      sources: '',
      signal: new AbortController().signal,
    });
    ok(q.includes('`N. что наблюдаем | как проверить'));
    ok(q.includes('[edge]'));
  });

  it('отказ среды — признаком, пустой лист', async () => {
    const failing = {
      name: 'stub',
      async chat() {
        throw new ProviderEnvError('503 upstream');
      },
    } as unknown as ChatProvider;
    const res = await deriveClaimsBlind({
      provider: failing,
      model: 'm',
      params: null,
      system: '',
      sections,
      indexBlock: '',
      sources: '',
      signal: new AbortController().signal,
    });
    deepStrictEqual(res.claims, []);
    strictEqual(res.envFailure, '503 upstream');
    strictEqual(res.requestError, null, 'отказ среды не должен попадать и в requestError');
  });

  it('обычный отказ запроса — признаком requestError, не «пустой лист»', async () => {
    const failing = {
      name: 'stub',
      async chat() {
        throw new Error('таймаут сети');
      },
    } as unknown as ChatProvider;
    const res = await deriveClaimsBlind({
      provider: failing,
      model: 'm',
      params: null,
      system: '',
      sections,
      indexBlock: '',
      sources: '',
      signal: new AbortController().signal,
    });
    deepStrictEqual(res.claims, []);
    strictEqual(res.envFailure, null);
    strictEqual(res.requestError, 'таймаут сети');
  });

  it('успешный ответ — requestError и envFailure оба null', async () => {
    const res = await deriveClaimsBlind({
      provider: provider('1. x | y', []),
      model: 'm',
      params: null,
      system: '',
      sections,
      indexBlock: '',
      sources: '',
      signal: new AbortController().signal,
    });
    strictEqual(res.envFailure, null);
    strictEqual(res.requestError, null);
  });
});
