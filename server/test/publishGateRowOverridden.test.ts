/**
 * `publishGateLineFacts` (handoff, шапка «Статус» гейта «Проверка предусловий публикации»)
 * раньше брала статус через `runNamedGate` (уважает переопределение строки набора своей
 * командой), а подполя branchOk/hasCommit/junk — безусловно из `publishPreconditionCheck`,
 * встроенной логики. При переопределённой команде эти два источника отвечают на РАЗНЫЕ
 * вопросы, и шапка могла дать самопротиворечивую строку вида «Статус: ✅ · ветка: не та»
 * (ревью code-review-all, 2026-09-18). Тест — на вынесенный предикат `publishGateRowOverridden`,
 * без прогона самого гейта.
 */

import { deepStrictEqual } from 'node:assert/strict';
import { describe, it } from 'node:test';

import { publishGateRowOverridden } from '../src/run/stages/handoff.ts';
import type { GatesFile } from '../src/gates/gatesFile.ts';

function gatesWith(row: Partial<GatesFile['rows'][number]> & { name: string }): GatesFile {
  return {
    rows: [
      {
        enabled: true,
        minimum: false,
        reportsAt: 'этап 7',
        implementation: '',
        command: null,
        ...row,
      },
    ],
    debt: [],
    calibration: [],
  };
}

describe('publishGateRowOverridden', () => {
  it('набора нет — не переопределён', () => {
    deepStrictEqual(publishGateRowOverridden(null), false);
  });

  it('строки гейта в наборе нет — не переопределён', () => {
    deepStrictEqual(publishGateRowOverridden(gatesWith({ name: 'Сборка' })), false);
  });

  it('строка есть, команды нет (проза) — не переопределён, подполя считаются builtin', () => {
    const gates = gatesWith({
      name: 'Проверка предусловий публикации',
      implementation: 'встроенная проверка',
      command: null,
    });
    deepStrictEqual(publishGateRowOverridden(gates), false);
  });

  it('строка переопределена командой в обратных кавычках — переопределён', () => {
    const gates = gatesWith({
      name: 'Проверка предусловий публикации',
      implementation: '`scripts/check-publish.sh`',
      command: 'scripts/check-publish.sh',
    });
    deepStrictEqual(publishGateRowOverridden(gates), true);
  });

  it('сопоставление имени через gateKey — регистр и пробелы не мешают найти строку', () => {
    const gates = gatesWith({
      name: '  проверка ПРЕДУСЛОВИЙ   публикации  ',
      command: './check.sh',
    });
    deepStrictEqual(publishGateRowOverridden(gates), true);
  });
});
