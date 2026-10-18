import { strictEqual } from 'node:assert/strict';
import { describe, it } from 'node:test';

import { researchProblem } from '../src/artifacts/preparation.ts';

describe('preparation intent section aliases', () => {
  it('accepts a substantive user-provided outcome heading', () => {
    const intent = [
      '# Task',
      '## Коротко',
      'Аудитория: операторы. Ожидаемый результат: перенос брони.',
      '## Зачем',
      'Сохранить идентификатор и срок брони.',
      '**Что должно получиться:** функция переносит бронь с сохранением id и срока.',
      '## Чего не делаем',
      'Не меняем существующие тесты.',
    ].join('\n');
    strictEqual(researchProblem(intent), null);
  });

  it('accepts complete h1-style section headings used by concise model drafts', () => {
    const intent = [
      '# Коротко', 'Перенос сохраняет id и срок.',
      '# Зачем', 'Текущий перенос теряет id.',
      '# Что делаем', 'Добавить moveHold и отдельные тесты.',
      '# Чего не делаем', 'Не менять существующие тесты.',
    ].join('\n');
    strictEqual(researchProblem(intent), null);
  });

  it('accepts concise equivalent sections with bold labels', () => {
    const intent = [
      '# Task',
      '## Назначение',
      '**Аудитория:** диспетчеры.',
      '**Проблема:** перенос меняет идентификатор и срок.',
      '**Желаемый результат:** перенос сохраняет оба значения.',
      '## Границы',
      'Не менять существующие тесты.',
    ].join('\n');
    strictEqual(researchProblem(intent), null);
  });

  it('lets research questions proceed to explore instead of blocking entry to it', () => {
    const intent = [
      '# Task',
      '## Назначение',
      '**Аудитория:** диспетчеры.',
      '**Проблема:** перенос меняет идентификатор и срок.',
      '**Желаемый результат:** перенос сохраняет оба значения.',
      '## Границы',
      'Не менять существующие тесты.',
      '## Открытые вопросы',
      '- [ ] [исследование] Какой из двух способов соответствует текущему объекту?',
    ].join('\n');
    strictEqual(researchProblem(intent), null);
  });

  it('rejects a required heading whose only content is a template placeholder', () => {
    const intent = [
      '# Task',
      '## Коротко',
      'Перенос брони сохраняет её идентификатор и срок.',
      '## Зачем',
      'Перенос сейчас теряет идентификатор.',
      '## Что делаем',
      '‹наблюдаемое изменение поведения›',
      '## Чего не делаем',
      'Существующие тесты не меняются.',
    ].join('\n');
    strictEqual(researchProblem(intent), 'для исследования заполни «Что делаем»: цель, результат и границы');
  });
});
