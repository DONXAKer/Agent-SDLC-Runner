import { deepStrictEqual, match, strictEqual } from 'node:assert/strict';
import { describe, it } from 'node:test';
import { deriveSchema } from '../src/artifacts/formSchema.ts';
import { compactScalarContext, copiedOtherSectionHeading, structuredScalarAnswer } from '../src/exec/FormFillExecutor.ts';

describe('compact scalar context', () => {
  it('shows the date target even when the id comes from the first label on a compound line', () => {
    const text = '- **Задача:** `intent.md` (case) · **План:** `plan.md`, одобрение от ‹дата›\n';
    const field = deriveSchema(text).fields.find((f) => f.kind === 'scalar')!;
    const context = compactScalarContext(field, text).join('\n');
    match(context, /одобрение от ‹дата›/);
    match(context, /заполняемое место: ‹дата›/);
  });
  it('does not add scalar instructions to a choice field', () => {
    const text = '- **Статус:** ‹да/нет›\n';
    const field = deriveSchema(text).fields[0]!;
    deepStrictEqual(compactScalarContext(field, text), []);
  });

  it('rejects whole-document responses in scalar slots but keeps a single scalar', () => {
    strictEqual(structuredScalarAnswer('Добавить surcharge для негабаритных отправлений.'), false);
    strictEqual(structuredScalarAnswer('## Готовность\n1. План заполнен\n2. Условия проверены'), true);
    strictEqual(structuredScalarAnswer('- **Summary:** do X\n- **Changes:** do Y'), true);
  });
});

describe('compact list form boundary', () => {
  it('rejects a neighboring section title copied into the current list answer', () => {
    const form = '## Что делаем\n- ‹пункт›\n\n## Чего не делаем\n- ‹пункт›\n\n## Приёмочный лист\n';
    strictEqual(copiedOtherSectionHeading('- Добавить тариф\n- **Чего не делаем**\n- Не менять скидку', form, 'что делаем'), 'чего не делаем');
  });

  it('rejects a scalar answer that expands into the whole form with neighboring bold labels', () => {
    const form = '## Do\n‹one field›\n\n## Do not\n‹one field›\n\n## Acceptance\n‹one field›';
    const answer = '- **Summary:** add surcharge\n- **Do:** add a field\n- **Do not:** change normal rates\n- **Acceptance:** tests\n';
    strictEqual(copiedOtherSectionHeading(answer, form, 'Do'), 'do not');
  });

  it('keeps ordinary list text and its own section title', () => {
    const form = '## Что делаем\n- ‹пункт›\n\n## Чего не делаем\n- ‹пункт›';
    strictEqual(copiedOtherSectionHeading('- добавить тариф\n- сохранить совместимость', form, 'Что делаем'), null);
    strictEqual(copiedOtherSectionHeading('- Что делаем', form, 'Что делаем'), null);
  });
});
