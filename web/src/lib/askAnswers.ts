import type { Question } from '@sdlc-runner/shared';

/**
 * Отвечены ли ВСЕ подвопросы — выбранной опцией или своим текстом.
 *
 * Выделено из `AskHumanDialog`, чтобы проверяться Node'ом напрямую: `.tsx` без сборки
 * Node не читает, а разгадывать логику кнопки «Ответить» глазами в компоненте — то же
 * самое доверие коду без проверки, от которого и защищает тест.
 */
export function allQuestionsAnswered(
  questions: readonly Question[],
  picked: Readonly<Record<string, string[]>>,
  custom: Readonly<Record<string, string>>,
): boolean {
  return questions.every(
    (q) => (picked[q.id] ?? []).length > 0 || (custom[q.id]?.trim() ?? '') !== '',
  );
}
