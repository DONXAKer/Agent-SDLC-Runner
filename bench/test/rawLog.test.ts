/**
 * Сброс сырого дампа между сэмплами серии (`server/src/provider/rawLog.ts`).
 *
 * Выключение после трёх отказов записи действует на процесс, а сэмплы серии `--repeat` идут в
 * одном процессе: без `resetRawLog` икота первого сэмпла гасила корпус всех остальных, а
 * без `rawLogDisabledReason` сводка серии об этом молчала. Дамп — часть обвязки бенчмарка,
 * поэтому поведение, на которое опирается `cli.ts`, проверяется здесь.
 */

import { ok, strictEqual } from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { dumpExchange, rawLogDisabledReason, resetRawLog } from '../../server/src/provider/rawLog.ts';

const LABEL = { slug: 'bench-raw', stage: 'chunk', mode: 'loop' as const };
const EXCHANGE = { provider: 'p', model: 'm', request: {}, response: '{}', status: 200, durationMs: 1 };

describe('rawLog: сброс между сэмплами серии', () => {
  const root = mkdtempSync(join(tmpdir(), 'sdlc-bench-rawlog-'));
  const saved = process.env['SDLC_RAW_LOG_DIR'];
  after(() => {
    if (saved === undefined) delete process.env['SDLC_RAW_LOG_DIR'];
    else process.env['SDLC_RAW_LOG_DIR'] = saved;
    resetRawLog();
    rmSync(root, { recursive: true, force: true });
  });

  it('три отказа гасят дамп с названной причиной; resetRawLog возвращает его следующему сэмплу', () => {
    // Каталог «внутри файла» не создаётся ни на одной платформе — надёжный отказ записи.
    const file = join(root, 'не-каталог');
    writeFileSync(file, 'x', 'utf8');
    process.env['SDLC_RAW_LOG_DIR'] = join(file, 'raw');
    resetRawLog();

    for (let i = 0; i < 3; i++) strictEqual(dumpExchange(LABEL, EXCHANGE), null);
    const reason = rawLogDisabledReason();
    ok(reason !== null && reason.includes('3 отказов'), String(reason));

    process.env['SDLC_RAW_LOG_DIR'] = join(root, 'raw');
    strictEqual(dumpExchange(LABEL, EXCHANGE), null, 'без сброса дамп остаётся выключенным на весь процесс');

    resetRawLog();
    strictEqual(rawLogDisabledReason(), null);
    const path = dumpExchange(LABEL, EXCHANGE);
    ok(path !== null && existsSync(path), String(path));
  });
});
