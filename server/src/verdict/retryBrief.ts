/**
 * Выжимка причин красного вердикта — вход следующей попытки chunk'а.
 *
 * Без неё повторная попытка получала тот же промпт, что и первая: модель заново читала
 * задачу, план и diff и заново угадывала, что именно не понравилось, — при том что причины
 * уже посчитаны и лежат рядом. Это самый дешёвый рычаг сокращения числа итераций: данные
 * собраны, транспорт (`extra` → `buildPrompt`) написан, недоставало сборки текста.
 *
 * Функция чистая и без I/O — как и всё в `verdict/`: её вход целиком определяет её выход,
 * поэтому она проверяется таблицей, а не прогоном витка.
 *
 * Здесь ПЕРЕЧЕНЬ ФАКТОВ, а не инструкция. «Упал гейт X, последняя строка такая» — факт;
 * «исправь X так-то» — уже решение, которое принимает исполнитель, глядя на код. Из
 * последней строки вывода сборки диагноз ошибки не следует, и притворяться иначе значит
 * подсказывать неверное направление с уверенным видом.
 */

import type { GateRunResult, VerdictInput } from '@sdlc-runner/shared';

/** Пустая строка вывода — это «вывода не было», а не «причина неизвестна». */
function lastLineOf(g: GateRunResult): string {
  return g.lastLine.trim() === '' ? 'вывод пуст' : g.lastLine.trim();
}

function gateLine(g: GateRunResult): string {
  const how = g.command ?? 'без команды';
  const code = g.exitCode === null ? '' : `, код ${g.exitCode}`;
  return `- «${g.name}» (${how}${code}): ${lastLineOf(g)}`;
}

/**
 * Собирает блок «что не сошлось» по входу вердикта и фактическому прогону гейтов.
 *
 * `null` — сказать нечего: вердикт красным не был или ни одной называемой причины не
 * нашлось. Пустой блок в промпт не уходит: раздел без содержимого читается как «претензий
 * нет», а это не то же самое, что «претензии не собрались».
 */
export function buildRetryBrief(
  input: VerdictInput,
  gateResults: readonly GateRunResult[],
): string | null {
  const sections: string[] = [];

  const failedClaims = input.claims.filter((c) => c.status !== '✅');
  if (failedClaims.length > 0) {
    sections.push(
      'Пункты приёмки, которые не закрыты:',
      ...failedClaims.map(
        (c) =>
          `- ${c.id} — ${
            c.status === '❌' ? 'опровергнут (❌)' : 'не проверяем (⚠): доказательство держится на непройденной проверке'
          }`,
      ),
    );
  }

  // Статусы берём из фактического прогона, а не из отчёта: отчёт мог их переписать, и в
  // вердикт всё равно шёл худший из двух.
  const failedGates = gateResults.filter((g) => g.status === '❌');
  if (failedGates.length > 0) {
    sections.push('Гейты, которые упали:', ...failedGates.map(gateLine));
  }

  const unsignedSkips = input.gates.filter(
    (g) =>
      g.status === '⏭' &&
      (g.inapplicableSignedBy === null || g.inapplicableSignedBy.trim() === ''),
  );
  if (unsignedSkips.length > 0) {
    sections.push(
      'Гейты, которые включены, но не запускались (строки неприменимости с именем нет):',
      ...unsignedSkips.map((g) => `- «${g.name}»`),
    );
  }

  if (input.confirmedReviewFindings > 0) {
    sections.push(
      `Подтверждённых расхождений из ревью: ${input.confirmedReviewFindings}. Каждое роняет ` +
        'вердикт само по себе, даже если пункта приёмки на это поведение нет.',
    );
  }

  const lists: [string, readonly string[]][] = [
    ['Нарушенные инварианты:', input.brokenInvariants],
    ['Регрессии:', input.regressions],
    ['Файлы плана, которых правка не коснулась:', input.plannedPathsUntouched],
    ['Открытые строки долга:', input.openDebtRows],
    ['Включённые гейты, не отчитавшиеся в отчёте:', input.enabledGatesMissingFromReport],
  ];
  for (const [title, items] of lists) {
    if (items.length > 0) sections.push(title, ...items.map((v) => `- ${v}`));
  }

  if (!input.diffMatchesTree) {
    sections.push(
      'Diff в отчёте разошёлся с деревом: проверялось не то, что лежит в рабочем каталоге.',
    );
  }

  if (input.noProgress) {
    sections.push(
      'Прогресса нет: патч этой попытки совпал с предыдущим. Повтор того же изменения ' +
        'ничего не даст — нужно другое.',
    );
  }

  if (sections.length === 0) return null;

  return [
    '## Что не сошлось в прошлой попытке',
    '',
    'Ниже — факты прошлого прогона, посчитанные рантаймом, а не пересказ чужого мнения.',
    'Что именно чинить, решаешь ты, глядя на код: из последней строки вывода диагноз',
    'ошибки не следует.',
    '',
    ...sections,
  ].join('\n');
}
