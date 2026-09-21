/**
 * JSON Schema для закрытых вопросов (`ModelDef.constrainedChoice`) — форма ответа
 * гарантируется декодером сервера, а не только пост-разбором.
 */

import { deepStrictEqual, ok, strictEqual } from 'node:assert/strict';
import { describe, it } from 'node:test';

import { claimsSchema, choiceSchema, withResponseFormat } from '../src/provider/responseFormat.ts';

describe('choiceSchema', () => {
  it('строка с enum ровно из переданных ключей', () => {
    const f = choiceSchema(['✅', '❌', '⏭']);
    deepStrictEqual(f.schema, { type: 'string', enum: ['✅', '❌', '⏭'] });
  });
});

describe('claimsSchema', () => {
  it('массив ровно из ids.length записей, id/status ограничены enum', () => {
    const f = claimsSchema(['claim-1', 'claim-2']);
    const schema = f.schema as {
      properties: {
        claims: {
          type: string;
          minItems: number;
          maxItems: number;
          items: { properties: { id: { enum: string[] }; status: { enum: string[] } }; required: string[] };
        };
      };
      required: string[];
    };
    strictEqual(schema.properties.claims.minItems, 2);
    strictEqual(schema.properties.claims.maxItems, 2);
    deepStrictEqual(schema.properties.claims.items.properties.id.enum, ['claim-1', 'claim-2']);
    deepStrictEqual(schema.properties.claims.items.properties.status.enum, ['✅', '❌', '⚠', 'manual']);
    deepStrictEqual(schema.properties.claims.items.required, ['id', 'status', 'evidence', 'what_to_fix']);
    deepStrictEqual(schema.required, ['claims']);
  });

  it('uniqueItems и minLength закрывают дубль-id и пустой evidence/what_to_fix (code-review-all, 2026-09-21)', () => {
    const f = claimsSchema(['claim-1', 'claim-2']);
    const schema = f.schema as {
      properties: {
        claims: {
          uniqueItems: boolean;
          items: { properties: { evidence: { minLength: number }; what_to_fix: { minLength: number } } };
        };
      };
    };
    strictEqual(schema.properties.claims.uniqueItems, true);
    strictEqual(schema.properties.claims.items.properties.evidence.minLength, 1);
    strictEqual(schema.properties.claims.items.properties.what_to_fix.minLength, 1);
  });
});

describe('withResponseFormat', () => {
  it('добавляет response_format с json_schema и strict:true', () => {
    const body = withResponseFormat(null, choiceSchema(['a', 'b']));
    const rf = body['response_format'] as { type: string; json_schema: { strict: boolean; schema: unknown } };
    strictEqual(rf.type, 'json_schema');
    strictEqual(rf.json_schema.strict, true);
    deepStrictEqual(rf.json_schema.schema, { type: 'string', enum: ['a', 'b'] });
  });

  it('явный response_format оператора (ModelDef.params) побеждает динамическую схему', () => {
    const body = withResponseFormat({ response_format: { type: 'text' } }, choiceSchema(['a', 'b']));
    deepStrictEqual(body['response_format'], { type: 'text' });
  });

  it('прочие поля params (temperature, max_tokens) сохраняются рядом', () => {
    const body = withResponseFormat({ temperature: 0.1, max_tokens: 500 }, choiceSchema(['a']));
    strictEqual(body['temperature'], 0.1);
    strictEqual(body['max_tokens'], 500);
    ok('response_format' in body);
  });

  it('base=null — response_format всё равно на месте', () => {
    const body = withResponseFormat(null, claimsSchema(['claim-1']));
    ok('response_format' in body);
  });

  it('base=undefined ведёт себя как null', () => {
    const body = withResponseFormat(undefined, choiceSchema(['a']));
    ok('response_format' in body);
  });
});
