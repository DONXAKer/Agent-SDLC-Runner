/**
 * Автозаполнение отчёта приёмки фактами прогона гейтов — до модели-рецензента.
 *
 * Контракт: механика шапки и таблица «Гейты» заполняются фактами рантайма, содержательные
 * секции (пункты приёмки, ревью, вердикт) и решения человека не трогаются.
 */

import { match, doesNotMatch, strictEqual } from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { GateRunResult } from '@sdlc-runner/shared';

import { autofillVerificationReport } from '../src/run/verifyAutofill.ts';

const TEMPLATE = `# Отчёт приёмки: ‹название витка›, chunk ‹N›, попытка ‹K›

- **Diff:** \`chunk-‹N›-attempt-‹K›-diff.patch\`, база ‹base_sha›, дерево ‹head_sha›

## Гейты

| Гейт | Статус | Результат |
|---|---|---|
| Сборка | ‹✅/❌/⏭› | ‹команда · код возврата · время› |
| Тесты | ‹✅/❌/⏭› | ‹команда · N passed / M failed› |
| Ревью независимым агентом | ‹✅/❌› | ‹модель, что подано на вход; итог — §2› |
| ‹прочий включённый гейт этапа 6› | ‹✅/❌/⏭› | ‹результат› |

| Гейт | Почему бессмыслен для этого diff'а | Утвердил (человек) |
|---|---|---|
| ‹гейт› | ‹причина› | ‹имя› |

### Гейты ранних этапов

| Гейт | Этап | Статус | Где виден |
|---|---|---|---|
| ‹гейт› | ‹этап› | ‹✅/❌/⏭› | ‹артефакт› |

## Вердикт

- **passed:** true / false
- **Попытка:** ‹K› из ‹бюджет›
`;

function gate(name: string, status: '✅' | '❌' | '⏭', lastLine: string): GateRunResult {
  return { name, status, command: null, exitCode: 0, lastLine, durationMs: 1200, envBlocked: false };
}

const FACTS = { chunk: 1, attempt: 2, slug: 'bench-oversize', attemptBudget: 3 };

describe('autofillVerificationReport', () => {
  it('строки таблицы «Гейты» получают фактический статус и результат', () => {
    const { text } = autofillVerificationReport(
      TEMPLATE,
      [gate('Сборка', '✅', 'ок'), gate('Тесты', '❌', '3 failed\n  и подробность')],
      FACTS,
    );
    match(text, /\| Сборка \| ✅ \| .*ок.* \|/);
    // Многострочный lastLine сплющен в одну ячейку.
    match(text, /\| Тесты \| ❌ \| [^\n]*3 failed; и подробность[^\n]* \|/);
  });

  it('строка-образец «прочий гейт» разворачивается в непокрытые именованными строками гейты', () => {
    const { text } = autofillVerificationReport(
      TEMPLATE,
      [gate('Сборка', '✅', 'ок'), gate('Секреты в diff', '✅', 'чисто')],
      FACTS,
    );
    match(text, /\| Секреты в diff \| ✅ \| .*чисто.* \|/);
    doesNotMatch(text, /прочий включённый гейт/);
  });

  it('строка ревью не трогается: рантайм не запускал рецензента на момент заполнения', () => {
    const { text } = autofillVerificationReport(TEMPLATE, [gate('Сборка', '✅', 'ок')], FACTS);
    match(text, /\| Ревью независимым агентом \| ‹✅\/❌› \|/);
  });

  it('механика шапки и вердикта: N, K, слаг, бюджет; sha и решения человека — нет', () => {
    const { text } = autofillVerificationReport(TEMPLATE, [], FACTS);
    match(text, /# Отчёт приёмки: bench-oversize, chunk 1, попытка 2/);
    // Имя патча в шапке — инлайн-код: `placeholderRanges` его не видит по построению,
    // и рантайм честно оставляет строку модели вместо разбора бэктиков вторым способом.
    match(text, /chunk-‹N›-attempt-‹K›-diff\.patch/);
    match(text, /\*\*Попытка:\*\* 2 из 3/);
    match(text, /‹base_sha›/);
    match(text, /\| ‹гейт› \| ‹причина› \| ‹имя› \|/);
  });

  it('таблица неприменимости и гейты ранних этапов не заполняются даже при совпадении имён', () => {
    const { text } = autofillVerificationReport(
      TEMPLATE,
      [gate('Сборка', '✅', 'ок')],
      FACTS,
    );
    // Секция «Гейты ранних этапов» — за пределами таблицы «Гейты», строка-образец цела.
    match(text, /\| ‹гейт› \| ‹этап› \| ‹✅\/❌\/⏭› \| ‹артефакт› \|/);
  });

  it('идемпотентно: повторный вызов ничего не находит', () => {
    const first = autofillVerificationReport(TEMPLATE, [gate('Сборка', '✅', 'ок')], FACTS);
    const second = autofillVerificationReport(first.text, [gate('Сборка', '✅', 'ок')], FACTS);
    strictEqual(second.filled, 0);
    strictEqual(second.text, first.text);
  });
});
