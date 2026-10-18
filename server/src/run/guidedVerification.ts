import type { GateRunResult } from '@sdlc-runner/shared';
import { escapeCell } from '../md/table.ts';
import { gateKey } from '../gates/gatesFile.ts';
import { renderRecords } from './verifyReport.ts';
import type { ClaimRecord, FindingRecord } from './verifyReport.ts';

/** Render observations, never ask a model to restate runtime facts or sign an exemption. */
export function renderGuidedVerification(input: {
  header: string;
  gates: readonly GateRunResult[];
  requiredGates: readonly { name: string; runtime: boolean }[];
  claims: readonly ClaimRecord[];
  titles: ReadonlyMap<string, string>;
  findings: readonly FindingRecord[];
  reviewComplete: boolean;
  earlyGates: readonly { name: string; stage: string; status: string; seenIn: string }[];
  /**
   * `false` — скан выполняла та же модель, что и исполнитель: его находки справочные
   * (advisory), и формулировки отчёта не называют скан «независимым». Умолчание —
   * `true`, прежняя форма.
   */
  scanIndependent?: boolean;
}): string {
  const row = (cells: readonly string[]): string => `| ${cells.map(escapeCell).join(' | ')} |`;
  const gates = new Map(input.gates.map(g => [gateKey(g.name), g]));
  const names = new Map(input.gates.map(g => [gateKey(g.name), g.name]));
  for (const g of input.requiredGates) names.set(gateKey(g.name), g.name);
  const gateRows = [...names].map(([key, name]) => {
    const fact = gates.get(key);
    const runtime = input.requiredGates.find(g => gateKey(g.name) === key)?.runtime;
    return row([name, fact?.status ?? (runtime ? '✅' : '‹статус›'), fact
      ? `${fact.command ?? 'встроенная проверка'}; код ${fact.exitCode ?? 'н/п'}; ${fact.lastLine}`.slice(0, 1800).replace(/\s+/gu, ' ')
      : runtime ? 'проверяет рантайм при расчёте вердикта' : '‹результат проверки›']);
  });
  // Полноту отчёта определяют только БЛОКИРУЮЩИЕ находки: справочная находка
  // саморевью без якоря не оставляет отчёт незаполненным — она и так не в вердикте.
  const complete = input.reviewComplete && input.findings.filter((f) => f.advisory !== true).every(f => f.anchored);
  const scanNote = input.scanIndependent === false
    ? 'скан выполнен той же моделью, что и исполнитель; находки — справочные (advisory), перечислены отдельно'
    : 'по ответам независимого скана; находки перечислены отдельно';
  const text = [input.header.trimEnd(), '', '## Гейты', '',
    '| Гейт | Статус | Результат |', '|---|---|---|', ...gateRows, '',
    'Освобождения от гейтов не заявлены; подписи человека не создаются рантаймом.', '',
    '### Гейты ранних этапов', '', '| Гейт | Этап | Статус | Где виден |', '|---|---|---|---|',
    ...input.earlyGates.map(g => row([g.name, g.stage, g.status, g.seenIn])), '',
    '## 1. Пункты приёмки', '',
    '| id | Пункт (первые слова, дословно) | passed | Чем подтверждён | Что чинить |', '|---|---|---|---|---|',
    ...[...input.titles].map(([id, title]) => row([id, title, '‹статус›', '‹свидетельство›', '‹исправление›'])), '',
    '## 2. Ревью: что искали опровергнуть', '',
    `- Подтверждённое расхождение: ${complete ? `нет — ${scanNote}` : '‹ревью не завершено›'}`,
    `- Оси «Последствий шагов»: ${complete ? `нет — все вопросы по осям отвечены; ${scanNote}` : '‹оси не проверены›'}`, '',
    '## 3. Scope', '', 'Состав и неизменённые пути проверены фактическими scope-гейтами выше.', '',
    '## 4. Инварианты', '', 'Нарушения из независимого скана перечисляются ниже.', '',
    '## 5. Регрессии', '',
    complete ? `- нет — ${scanNote}` : '- ‹ревью не завершено›', '',
    '## Вердикт', '', '- **passed:** ожидает расчёта рантайма', '- **По каким условиям упал:** ожидает расчёта рантайма',
    '- **action:** ожидает расчёта рантайма', '',
  ].join('\n');
  // Scope findings must also reach the verdict's confirmed discrepancy channel.
  // Unanchored concerns leave the report incomplete until resolved. Advisory findings
  // are excluded from both: they never reach the verdict by construction.
  const findings = input.findings.flatMap(f => f.section === 'scope' && f.anchored && f.advisory !== true
    ? [f, { ...f, section: 'review' as const }]
    : [f]);
  return renderRecords(text, { claims: input.claims, findings, titles: input.titles }).text;
}
