/**
 * Тесты парсера аргументов.
 *
 * Флаги проверяются здесь целиком — и `--key value`, и `--flag`: команды, которым флаги
 * ещё только предстоит получить, парсер переписывать не должны.
 */

import { deepStrictEqual, throws } from 'node:assert/strict';
import { describe, it } from 'node:test';

import { parseArgs } from '../src/index.ts';

describe('parseArgs', () => {
  it('команда — первый токен, остальные позиционные — её аргументы', () => {
    deepStrictEqual(parseArgs(['quote', 'msk', '2']), { cmd: 'quote', args: ['msk', '2'], flags: {} });
  });

  it('пустой argv — пустая команда', () => {
    deepStrictEqual(parseArgs([]), { cmd: '', args: [], flags: {} });
  });

  it('--key value забирает следующий токен как значение', () => {
    deepStrictEqual(parseArgs(['list', '--zone', 'msk']), { cmd: 'list', args: [], flags: { zone: 'msk' } });
  });

  it('--flag без значения — true', () => {
    deepStrictEqual(parseArgs(['quote', 'msk', '2', '--json']), {
      cmd: 'quote',
      args: ['msk', '2'],
      flags: { json: true },
    });
  });

  it('флаг перед другим флагом значения не забирает', () => {
    deepStrictEqual(parseArgs(['list', '--json', '--zone', 'msk']).flags, { json: true, zone: 'msk' });
  });

  it('«--» без имени — ошибка, а не флаг с пустым ключом', () => {
    throws(() => parseArgs(['list', '--']), /пустое имя флага/);
  });
});
