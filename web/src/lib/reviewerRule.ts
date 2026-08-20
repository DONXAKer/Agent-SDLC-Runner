import type { ConfigInfo, StageId } from '@sdlc-runner/shared';

/**
 * Правило рецензента на стороне клиента: `verify` обязан быть строго сильнее `chunk`.
 *
 * Живёт отдельно от `ProfileEditor`, а не внутри него, по двум причинам. Первая — это
 * правило, а не разметка: его надо проверять, а компонент проверять нечем (тестов React в
 * проекте нет). Вторая — оно уже один раз разошлось с сервером: пока ранги считались
 * только по ПРАВКАМ оператора, самый частый случай (поднять один `chunk` до уровня
 * базового `verify`) клиент пропускал молча, а сервер отказывал в старте.
 *
 * Клиент ничего не разрешает — он только предупреждает раньше. Местом, где виток не
 * стартует, остаётся сервер (`checkReviewerRule`), и правило здесь повторяет серверное:
 * сравниваются КРАЙНИЕ значения ансамбля — сильнейший исполнитель против слабейшего
 * рецензента. Иначе ансамбль стал бы способом протащить слабого рецензента рядом с
 * сильным.
 */

export interface RuleInput {
  models: ConfigInfo['models'];
  /** Правки оператора на этот виток: этап → модель. Пусто — берётся профиль как есть. */
  stages: Partial<Record<StageId, string>>;
  /** Модели выбранного профиля — то, что действует на нетронутых этапах. */
  base: Partial<Record<StageId, string[]>>;
}

export interface RuleVerdict {
  /** `null` — ранг неизвестен ни из правки, ни из профиля: сравнивать нечем. */
  chunkRank: number | null;
  verifyRank: number | null;
  /** Правило нарушено — виток не стартует. */
  broken: boolean;
}

export function evaluateReviewerRule(i: RuleInput): RuleVerdict {
  const rankOf = (id: string | undefined): number | null =>
    i.models.find((m) => m.id === id)?.rank ?? null;

  const effective = (stage: StageId, pick: (a: number, b: number) => number): number | null => {
    const override = rankOf(i.stages[stage]);
    if (override !== null) return override;
    const ranks = (i.base[stage] ?? [])
      .map((id) => rankOf(id))
      .filter((r): r is number => r !== null);
    // Именно `(a, b) => pick(a, b)`, а не `ranks.reduce(pick)`: `reduce` передаёт в
    // колбэк ещё индекс и сам массив, и `Math.max(acc, value, 0, [...])` возвращает NaN —
    // ранг ансамбля молча становился «неизвестен», и правило переставало срабатывать.
    return ranks.length === 0 ? null : ranks.reduce((a, b) => pick(a, b));
  };

  const chunkRank = effective('chunk', Math.max);
  const verifyRank = effective('verify', Math.min);
  return { chunkRank, verifyRank, broken: chunkRank !== null && verifyRank !== null && verifyRank <= chunkRank };
}
