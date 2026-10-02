import { ok } from 'node:assert/strict';
import { describe, it } from 'node:test';

import { preparationFieldInstructions, preparationInstructions } from '../src/prompt/preparation.ts';

describe('Runner preparation prompt rules', () => {
  it('tells intent form fill to return field values and structured claim JSON', () => {
    const intent = preparationInstructions('', 'intent', true);
    ok(intent.includes('инструменты записи'));
    ok(intent.includes('sdlc-json:acceptance'));
    ok(intent.includes('sdlc-json:basis'));
    ok(intent.includes('не выбирай внутренний способ'));
    ok(preparationFieldInstructions('intent').includes('JSON-массив'));
  });

  it('grounds exploration in source cards provided by the runtime', () => {
    const explore = preparationInstructions('', 'explore', true);
    ok(explore.includes('карточки'));
    ok(preparationFieldInstructions('explore').includes('символ/тест'));
    ok(!explore.includes('инструментом Read'));
  });

  it('keeps plan approval and claim coverage explicit', () => {
    const plan = preparationInstructions('', 'plan', true);
    ok(plan.includes('Одобрение'));
    ok(plan.includes('Точно различай изменение объекта на месте и возврат нового объекта'));
    ok(preparationFieldInstructions('plan').includes('claim-N'));
  });

  it('keeps decision-focused guidance for the question stage', () => {
    ok(preparationInstructions('', 'ask').includes('Спрашивай только о нерешённом выборе'));
  });
});
