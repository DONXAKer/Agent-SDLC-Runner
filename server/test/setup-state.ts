/**
 * Каталог состояния рантайма для тестов — временный на процесс (`node --import`, его
 * наследует каждый файл `node --test`). Без этого тесты, доходящие до вердикта этапа 6,
 * писали в настоящий `~/.sdlc-runner` машины разработчика и делили его с живым сервером
 * (code-review-all 2026-09-23). Явно заданный `SDLC_STATE_DIR` уважается.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

if (process.env['SDLC_STATE_DIR'] === undefined || process.env['SDLC_STATE_DIR'] === '') {
  const dir = mkdtempSync(join(tmpdir(), 'sdlc-state-test-'));
  process.env['SDLC_STATE_DIR'] = dir;
  process.on('exit', () => rmSync(dir, { recursive: true, force: true }));
}
