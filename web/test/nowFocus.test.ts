/**
 * Машина фокуса вкладки «Сейчас»: в каждый момент видно одно главное, приоритет
 * фиксирован. Компонент по ней только рендерит — правила проверяются здесь.
 */

import { deepStrictEqual, strictEqual } from 'node:assert/strict';
import { describe, it } from 'node:test';

import { computeNowFocus } from '../src/lib/nowFocus.ts';
import type { NowFocusInput } from '../src/lib/nowFocus.ts';

function input(over: Partial<NowFocusInput> = {}): NowFocusInput {
  return { queueCount: 0, runningStage: null, verdictRed: false, nextRunnable: null, ...over };
}

describe('фокус вкладки «Сейчас»', () => {
  it('очередь решений бьёт всё — включая идущий этап и красный вердикт', () => {
    // «Молчание одобрением не считается»: карточки не смеет задвинуть ничто.
    deepStrictEqual(
      computeNowFocus(
        input({ queueCount: 2, runningStage: 'chunk', verdictRed: true, nextRunnable: 'verify' }),
      ),
      { kind: 'decisions', count: 2 },
    );
  });

  it('идущий этап важнее красного вердикта: новая попытка уже запущена', () => {
    deepStrictEqual(
      computeNowFocus(input({ runningStage: 'chunk', verdictRed: true, nextRunnable: 'chunk' })),
      { kind: 'running', stage: 'chunk' },
    );
  });

  it('красный вердикт важнее подготовки: виток стоит и ждёт решения о продвижении', () => {
    strictEqual(
      computeNowFocus(input({ verdictRed: true, nextRunnable: 'verify' })).kind,
      'verdict-red',
    );
  });

  it('тихий виток — подготовка самого дальнего доступного этапа', () => {
    deepStrictEqual(computeNowFocus(input({ nextRunnable: 'plan' })), {
      kind: 'prepare',
      stage: 'plan',
    });
  });

  it('запускать нечего — finished, а не подготовка несуществующего этапа', () => {
    strictEqual(computeNowFocus(input()).kind, 'finished');
  });
});
