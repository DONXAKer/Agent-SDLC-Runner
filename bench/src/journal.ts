/**
 * Черновик записи `docs/model-runs.md` (шаг 7 ROADMAP.md).
 *
 * Бенчмарк файл НЕ дописывает никогда: он не может проверить ни «менялось только одно»
 * (это знает человек, не прогон), ни отметку отозванного результата у прежней записи.
 * Печатает черновик в формате журнала — вклеивает человек сам, читая остальные записи.
 */

import { money } from '@sdlc-runner/shared';

import type { BenchResult } from './result.ts';
import type { Report } from './report.ts';

/** Знак журнала по исходу блока этапов — тот же алфавит, что в шапке `docs/model-runs.md`. */
function stageBlockSign(result: BenchResult, stages: readonly string[]): '✅' | '❌' | '—' {
  const recs = result.driver.stages.filter((s) => stages.includes(s.stage));
  if (recs.length === 0) return '—';
  if (recs.some((r) => !r.ok && !r.skipped)) return '❌';
  return '✅';
}

export function draftJournalEntry(args: { result: BenchResult; report: Report }): string {
  const { result, report } = args;
  const dateOnly = result.run.finishedAt.slice(0, 10);

  const early = stageBlockSign(result, ['intent', 'explore', 'ask', 'plan']);
  const chunk = stageBlockSign(result, ['chunk']);
  const verify = stageBlockSign(result, ['verify']);

  const weak = report.probes.filter((p) => p.verdict === '❌' || p.verdict === '⚠️');
  const strong = report.probes.filter((p) => p.verdict === '✅');

  // Стоимость — по валютам маршрутов: polza считает в рублях, и хардкод `$` выдавал
  // рублёвую трату за долларовую (~90-кратное завышение в глазах читателя журнала).
  // У смешанного профиля одна сумма честной не бывает — слагаемые печатаются раздельно
  // (тот же принцип, что у `RunCosts.currency` в shared/api.ts).
  const byCurrency = new Map<string, number>();
  for (const s of result.metrics.stages) {
    if (s.usage.costUsd === null) continue;
    const cur = result.run.currencies?.[s.stage] ?? 'USD';
    byCurrency.set(cur, (byCurrency.get(cur) ?? 0) + s.usage.costUsd);
  }
  const spent = [...byCurrency.entries()].map(([cur, v]) => money(v, cur)).join(' + ');

  return [
    `## \`${result.run.model}\` — bench, ${dateOnly}${report.dangerous ? ' — ⚠️ ОПАСНА' : ''}`,
    '',
    '| Этапы 1–4 | Этап 5 | Этап 6 |',
    '|---|---|---|',
    `| ${early} | ${chunk} | ${verify} |`,
    '',
    strong.length > 0
      ? `- **Сильные стороны.** ${strong.map((p) => `${p.name} — ${p.detail}`).join('; ')}.`
      : '- **Сильные стороны.** ‹не найдено ни одного зелёного щупа›',
    weak.length > 0
      ? `- **Слабые стороны.** ${weak.map((p) => `${p.name} — ${p.detail}`).join('; ')}.`
      : '- **Слабые стороны.** ‹не найдено›',
    `- **Что тюнить.** ‹дописать по факту — черновик не знает, что менялось между прогонами›`,
    `- **Вердикт.** ‹дописать словами, не только знаком — сверх формата, что и почему›`,
    '',
    `Стоимость витка: ${spent === '' ? 'не изм. (локальный провайдер)' : spent}. ` +
      `Остановка: \`${result.driver.stopped}\`. Результат: \`bench/results/${result.run.slug}.json\`.`,
    '',
    '‹дата прогона, машина, что менялось против предыдущей записи — заполняет человек›',
  ].join('\n');
}
