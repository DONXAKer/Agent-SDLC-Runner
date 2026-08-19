/**
 * Пост-виток отчёт «что съело итерации» — вход этапа 7.
 *
 * Собирается кодом из уже посчитанного: чисел витка и журнала итераций. Третьего источника
 * тут нет, и модель числа не сочиняет — она переносит блок в артефакт.
 *
 * Строго разделено наблюдаемое и ненаблюдаемое. Попытки, вердикты, время и расход рантайм
 * видел сам. «Почему исполнитель ошибся» он не видел, и такой строки в автогенерируемой
 * части быть не должно: догадка, поданная числами, выглядит как факт.
 */

import type { RunMetrics, Usage } from '@sdlc-runner/shared';

/** Формат стоимости повторяет правило интерфейса: ноль без токенов — это «нечего», а не «$0». */
function cost(u: Usage): string {
  if (u.costUsd === null) return 'без стоимости (локальный маршрут)';
  const tokens = u.inputTokens + u.outputTokens + u.cacheReadTokens + u.cacheWriteTokens;
  if (u.costUsd === 0 && tokens === 0) return '—';
  return `$${u.costUsd.toFixed(4)}`;
}

function duration(ms: number): string {
  if (ms < 1000) return `${ms} мс`;
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s} с` : `${Math.floor(s / 60)} мин ${s % 60} с`;
}

/**
 * `null` — витку нечего рассказать: ни одного прогона этапа не было. Пустая секция хуже
 * отсутствующей: она читается как «итераций не потребовалось».
 */
export function postmortemBlock(m: RunMetrics): string | null {
  if (m.stages.length === 0) return null;

  const attempts = m.attemptsByChunk.map((a) => `chunk ${a.chunk}: ${a.attempts}`).join(', ');
  const stageRows = m.stages.map(
    (s) =>
      `| ${s.stage} | ${s.runs} | ${duration(s.durationMs)} | ${cost(s.usage)} | ` +
      `↑${s.usage.inputTokens} ↓${s.usage.outputTokens} |`,
  );

  const lines = [
    '## Что съело итерации (посчитано рантаймом)',
    '',
    'Числа ниже — наблюдения рантайма, а не оценка. Перенеси их в отчёт как есть; выводы о',
    'причинах делает человек, потому что рантайм видел, ЧТО происходило, но не видел, ПОЧЕМУ.',
    '',
    `- Посчитанных вердиктов: ${m.verdicts.total}, из них красных: ${m.verdicts.red}.`,
    ...(attempts === '' ? [] : [`- Попыток по chunk'ам: ${attempts}.`]),
  ];

  if (m.redByCause.length > 0) {
    lines.push(
      `- Красные по классам причин: ${m.redByCause
        .map((c) => `${c.kind} — ${c.count}`)
        .join(', ')}.`,
    );
  } else if (m.verdicts.red > 0) {
    // Честно: классификатор не смог назвать класс. Это не то же самое, что «причин нет».
    lines.push('- Классы причин красного не определялись: разбивки нет.');
  }

  lines.push(
    '',
    '| Этап | Прогонов | Время | Стоимость | Токены |',
    '|---|---|---|---|---|',
    ...stageRows,
    '',
    'Подробная построчная история попыток — в `iterations.md` витка. Он тоже написан',
    'рантаймом: колонка «Заметка» там пустая, пока её не заполнит человек.',
  );

  return lines.join('\n');
}
