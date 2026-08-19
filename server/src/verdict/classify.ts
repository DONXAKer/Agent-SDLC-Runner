/**
 * Классификация причин красного вердикта: куда возвращать виток.
 *
 * У красного сегодня два исхода, и различает их счётчик, а не природа причины:
 * `decideAction` даёт `escalate` при исчерпанном бюджете или отсутствии прогресса и
 * `retry` во всех остальных случаях. Но упавшая сборка, вылазка за границы плана и
 * рецензент, разошедшийся с фактическим прогоном, лечатся по-разному, и оператор
 * различает это глазами на каждом красном. Различие выводится из уже посчитанных данных —
 * значит должно быть выведено кодом один раз.
 *
 * Что здесь НЕ делается:
 * - не трогается `passed`. Классификация отвечает только на вопрос «куда дальше»; любая
 *   ветка, влияющая на зелёный, — это ложный зелёный;
 * - не отменяется `decideAction`. `noProgress` и исчерпанный бюджет сильнее любой
 *   стратегии: классификатор отвечает, когда возврат вообще разрешён;
 * - ничего не спрашивается у модели. Это таблица по полям входа вердикта;
 * - не разбираются строки `reasons`. Формулировки человекочитаемы и меняются, привязка к
 *   их тексту разошлась бы с вердиктом молча. Источник — поля `VerdictInput`.
 */

import type { RedCause, RedCauseKind, VerdictInput } from '@sdlc-runner/shared';

import { gateKey } from '../gates/gatesFile.ts';

/**
 * Имя гейта → вид причины. Сравнение через `gateKey`, как и везде в рантайме: имена
 * приходят из человекописного набора целевого проекта, и regexp по имени в этом месте был
 * бы спецслучаем поверх общей инфраструктуры.
 *
 * Гейта, которого здесь нет, это не касается: неизвестный красный гейт попадает в общий
 * вид `gate` — «чинить на том же этапе», самая безопасная трактовка.
 */
const GATE_CAUSE = new Map<string, RedCauseKind>([
  [gateKey('Scope: файлы вне плана'), 'scope'],
  [gateKey('Сборка'), 'gate'],
  [gateKey('Тесты'), 'gate'],
  [gateKey('Анти-обход тест-гейта'), 'gate'],
  [gateKey('Секреты в diff'), 'gate'],
  [gateKey('Проверка предусловий публикации'), 'gate'],
]);

/**
 * Порядок разбора — «самая ранняя по витку причина побеждает».
 *
 * Нарушенный scope возвращает на план, даже если рядом упали тесты: после правки плана
 * chunk всё равно придётся переделывать, и чинить тесты раньше — работа впустую. Дальше
 * идёт разошедшийся рецензент: повторять его тем же весом бессмысленно.
 */
const ORDER: readonly RedCauseKind[] = ['scope', 'reviewer', 'gate', 'claim', 'integrity'];

const SUGGEST: Record<RedCauseKind, RedCause['suggest']> = {
  scope: 'back-to-plan',
  reviewer: 'escalate-model',
  gate: 'fix-in-chunk',
  claim: 'fix-in-chunk',
  integrity: 'fix-in-chunk',
};

/**
 * `null` — классифицировать нечего: вердикт зелёный либо ни одной называемой причины нет.
 *
 * `why` перечисляет ВСЕ найденные причины, а не только победившую: оператор должен видеть,
 * что кроме вылазки за границы плана упали ещё и тесты, — иначе предложение «вернуть на
 * план» выглядит произволом.
 */
export function classifyRedVerdict(
  input: VerdictInput,
  disagreements: readonly string[] = [],
): RedCause | null {
  const found = new Map<RedCauseKind, string[]>();
  const add = (kind: RedCauseKind, why: string): void => {
    const list = found.get(kind);
    if (list === undefined) found.set(kind, [why]);
    else list.push(why);
  };

  for (const g of input.gates) {
    if (g.status === '❌') {
      add(GATE_CAUSE.get(gateKey(g.name)) ?? 'gate', `гейт «${g.name}» провалился`);
      continue;
    }
    // Пропуск без подписанной неприменимости — это «не запускался», то есть работа не
    // сделана, а не «здесь неприменимо».
    if (
      g.status === '⏭' &&
      (g.inapplicableSignedBy === null || g.inapplicableSignedBy.trim() === '')
    ) {
      add('gate', `гейт «${g.name}» включён, но не запускался`);
    }
  }

  for (const name of input.enabledGatesMissingFromReport) {
    add('gate', `включённый гейт «${name}» не отчитался в отчёте`);
  }

  for (const c of input.claims) {
    if (c.status === '❌') add('claim', `пункт приёмки ${c.id} опровергнут`);
    else if (c.status === '⚠') add('claim', `пункт приёмки ${c.id} не проверяем`);
  }

  if (input.confirmedReviewFindings > 0) {
    add('claim', `подтверждённых расхождений из ревью: ${input.confirmedReviewFindings}`);
  }

  // Рецензент разошёлся с фактическим прогоном: статусы в отчёте не те, что дал рантайм.
  // Вердикт от этого не падает (в статус уже взят худший из двух), но повторять ревью
  // моделью того же веса незачем — она ошиблась не в коде, а в чтении фактов.
  for (const d of disagreements) add('reviewer', d);

  for (const v of input.brokenInvariants) add('integrity', `нарушен инвариант: ${v}`);
  for (const v of input.regressions) add('integrity', `регрессия: ${v}`);
  for (const v of input.plannedPathsUntouched) {
    add('integrity', `файл плана не тронут: ${v}`);
  }
  for (const v of input.openDebtRows) add('integrity', `открытая строка долга: ${v}`);
  if (!input.diffMatchesTree) {
    add('integrity', 'diff в отчёте разошёлся с деревом');
  }

  const kind = ORDER.find((k) => found.has(k));
  if (kind === undefined) return null;

  // Обоснование начинается с победившей причины, но перечисляет и остальные — в том же
  // порядке разбора, чтобы вывод был воспроизводим.
  const why = [
    ...(found.get(kind) ?? []),
    ...ORDER.filter((k) => k !== kind).flatMap((k) => found.get(k) ?? []),
  ];

  return { kind, suggest: SUGGEST[kind], why };
}
