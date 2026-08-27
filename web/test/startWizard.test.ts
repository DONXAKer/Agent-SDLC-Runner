/**
 * Мастер нового витка: что пускает на следующий шаг, а что нет.
 *
 * Правило рецензента здесь дублирует серверное сознательно — клиент ничего не разрешает,
 * он лишь не даёт дойти до кнопки, после которой сервер откажет в старте.
 */

import { strictEqual } from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  canProceed,
  nextStep,
  prevStep,
  stepBlocker,
  wizardOpenByDefault,
} from '../src/lib/startWizard.ts';
import type { WizardState } from '../src/lib/startWizard.ts';

function state(over: Partial<WizardState> = {}): WizardState {
  return { projectChosen: true, ruleBroken: false, slug: 'pay-412', ...over };
}

describe('переход между шагами мастера', () => {
  it('шаг проекта не пускает дальше без проекта, и называет причину', () => {
    strictEqual(canProceed(1, state({ projectChosen: false })), false);
    strictEqual(stepBlocker(1, state({ projectChosen: false })), 'Проект не выбран');
    strictEqual(canProceed(1, state()), true);
  });

  it('нарушенное правило рецензента запирает шаг моделей', () => {
    // Раньше клиент показывал предупреждение и пропускал дальше — виток создавался и
    // падал уже на сервере.
    strictEqual(canProceed(2, state({ ruleBroken: true })), false);
    strictEqual(canProceed(2, state()), true);
  });

  it('пустой и пробельный slug одинаково не пускают к запуску', () => {
    strictEqual(canProceed(3, state({ slug: '' })), false);
    strictEqual(canProceed(3, state({ slug: '   ' })), false);
    strictEqual(stepBlocker(3, state({ slug: '' })), 'Slug витка не задан');
    strictEqual(canProceed(3, state()), true);
  });

  it('шаги не выходят за границы 1..3', () => {
    strictEqual(nextStep(3), 3);
    strictEqual(prevStep(1), 1);
    strictEqual(nextStep(1), 2);
    strictEqual(prevStep(3), 2);
  });
});

describe('мастер открыт по умолчанию', () => {
  it('продолжать нечего — мастер сразу, без лишнего клика', () => {
    strictEqual(wizardOpenByDefault(0, 0), true);
  });

  it('есть открытый виток или история — сначала выбор, а не форма', () => {
    strictEqual(wizardOpenByDefault(1, 0), false);
    strictEqual(wizardOpenByDefault(0, 3), false);
  });
});
