/**
 * Страховка от дрейфа `contextWindow` в `config/models.json`: сегодняшний блок
 * `ollama:granite4.2-8b-ctx32k` (2026-09-25) случился ровно потому, что поле проставлялось
 * точечно под конкретные замеры, а преполётная проверка (`ollamaContext.ts::checkOllamaContext`)
 * ужесточена из предупреждения в жёсткий отказ тем же коммитом, что задел лишь часть тегов —
 * соседи по одному и тому же тегу (`-nofill`/`-mt`/`-selfreview`) остались без поля.
 *
 * Конвенция файла (комментарий `"// ollama и num_ctx"` в его же начале): суффикс `-ctx<N>k`
 * тега Ollama несёт `PARAMETER num_ctx <N>*1024`, и `contextWindow` обязан называть то же
 * число — иначе рантайм либо не может посчитать бюджет истории/`max_tokens`
 * (`server/src/exec/contextBudget.ts`), либо (без этого теста) блокируется преполётом на
 * живом прогоне вместо `npm test`.
 */

import { readFileSync } from 'node:fs';
import { deepStrictEqual } from 'node:assert/strict';
import { describe, it } from 'node:test';

import { configDir } from '../src/config/load.ts';
import type { ModelsConfig } from '../src/config/schema.ts';

describe('config/models.json: contextWindow тегов ollama ctx<N>k', () => {
  it('у каждой записи ollama с суффиксом -ctx<N>k contextWindow равен N*1024', () => {
    const config = JSON.parse(readFileSync(`${configDir()}/models.json`, 'utf8')) as ModelsConfig;
    const mismatched: string[] = [];
    for (const m of config.models) {
      if (m.provider !== 'ollama') continue;
      const ctx = /ctx(\d+)k/.exec(m.model);
      if (ctx === null) continue;
      const want = Number(ctx[1]) * 1024;
      if (m.contextWindow !== want) {
        mismatched.push(`${m.id}: contextWindow=${String(m.contextWindow)}, а тег «${m.model}» требует ${want}`);
      }
    }
    deepStrictEqual(mismatched, []);
  });
});
