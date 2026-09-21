/**
 * JSON Schema для закрытых вопросов (`ModelDef.constrainedChoice`): форма ответа
 * гарантируется декодером сервера, а не только пост-разбором на нашей стороне.
 *
 * Не второй источник допустимых значений: `choiceSchema` строит `enum` из тех же ключей,
 * что `artifacts/sheet.ts::matchChoice` уже принимает, `claimsSchema` — из `ClaimStatus`
 * (`@sdlc-runner/shared`), той же четвёрки, что разбирает `claimStatusOf`
 * (`exec/normalize.ts`). Разошлись бы эти списки — модель получала бы валидный по декодеру,
 * но отклонённый разбором ответ, то есть ту же цену переспроса, которую ручка снимает.
 */

import { CLAIM_STATUSES } from '@sdlc-runner/shared';

import { applyParams } from './ChatProvider.ts';

export interface JsonSchemaFormat {
  /** Имя схемы — только для журнала запроса на стороне провайдера, семантики не несёт. */
  name: string;
  schema: Record<string, unknown>;
}

/** Одно `choice`-поле формы: ответ — строка, один из перечисленных ключей. */
export function choiceSchema(keys: readonly string[]): JsonSchemaFormat {
  return {
    name: 'field_choice',
    schema: { type: 'string', enum: [...keys] },
  };
}

/**
 * Группа `claimFill` (до `CLAIM_GROUP` пунктов в одном запросе): массив ровно из
 * `ids.length` записей, `id` ограничен теми же пунктами, что задавались в этом запросе —
 * модель не может ответить за пункт, которого не спрашивали, и обязана ответить за каждый.
 *
 * `minItems`/`maxItems` без `uniqueItems` не гарантируют этого: массив нужной длины с
 * повторяющимся `id` формально валиден, а `parseClaimsJsonAnswer` дедуплицирует по `id`
 * через `answeredIdx` — реальные пункты молча остаются без ответа (code-review-all,
 * 2026-09-21). `minLength: 1` на `evidence`/`what_to_fix` по той же находке: без него
 * пустая строка проходит как ответ для ❌/⚠, где обоснование обязательно по методологии
 * (для зелёного статуса легитимное значение — `н/п`, оно не пустое).
 */
export function claimsSchema(ids: readonly string[]): JsonSchemaFormat {
  return {
    name: 'claims_answer',
    schema: {
      type: 'object',
      properties: {
        claims: {
          type: 'array',
          minItems: ids.length,
          maxItems: ids.length,
          uniqueItems: true,
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', enum: [...ids] },
              status: { type: 'string', enum: [...CLAIM_STATUSES] },
              evidence: { type: 'string', minLength: 1 },
              what_to_fix: { type: 'string', minLength: 1 },
            },
            required: ['id', 'status', 'evidence', 'what_to_fix'],
            additionalProperties: false,
          },
        },
      },
      required: ['claims'],
      additionalProperties: false,
    },
  };
}

/**
 * `params` запроса с добавленным `response_format`. Явный `response_format` оператора
 * (`ModelDef.params`) побеждает — тем же правилом, что и у любого другого поля `params`
 * (`applyParams`, `ChatProvider.ts`): динамическая схема кладётся первой, конфиг — поверх.
 */
export function withResponseFormat(
  base: Record<string, unknown> | null | undefined,
  format: JsonSchemaFormat,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    response_format: {
      type: 'json_schema',
      json_schema: { name: format.name, strict: true, schema: format.schema },
    },
  };
  applyParams(body, base ?? null);
  return body;
}
