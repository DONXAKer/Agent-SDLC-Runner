/**
 * `SDLC_PORT` переопределяет `runner.json` тем же способом, что и `SDLC_SKILLS_DIR` и
 * соседи — по значению из окружения, без правки закоммиченного файла.
 */

import { strictEqual, throws } from 'node:assert/strict';
import { describe, it } from 'node:test';

import { loadConfig } from '../src/config/load.ts';
import { withEnv } from './testUtils.ts';

describe('SDLC_PORT переопределяет config/runner.json', () => {
  it('не задан — берётся порт из runner.json', () => {
    withEnv('SDLC_PORT', undefined, () => {
      strictEqual(loadConfig().runner.port, 8030);
    });
  });

  it('задан — побеждает значение из файла', () => {
    withEnv('SDLC_PORT', '9999', () => {
      strictEqual(loadConfig().runner.port, 9999);
    });
  });

  it('пустая строка — тоже «не задано», а не 0', () => {
    withEnv('SDLC_PORT', '  ', () => {
      strictEqual(loadConfig().runner.port, 8030);
    });
  });

  it('не число — явная ошибка при загрузке, а не NaN в порту сервера', () => {
    withEnv('SDLC_PORT', 'восемь тысяч', () => {
      throws(() => loadConfig(), /SDLC_PORT/);
    });
  });

  it('вне диапазона портов — тоже явная ошибка', () => {
    withEnv('SDLC_PORT', '99999', () => {
      throws(() => loadConfig(), /SDLC_PORT/);
    });
  });

  it('шестнадцатеричная запись — явная ошибка, а не тихая подмена порта', () => {
    // Регрессия: голый Number('0x1F') === 31 — валидное целое для JS, но не то, что
    // оператор написал в .env.
    withEnv('SDLC_PORT', '0x1F', () => {
      throws(() => loadConfig(), /SDLC_PORT/);
    });
  });

  it('экспоненциальная запись — тоже явная ошибка', () => {
    withEnv('SDLC_PORT', '1e4', () => {
      throws(() => loadConfig(), /SDLC_PORT/);
    });
  });
});
