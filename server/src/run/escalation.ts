/**
 * Эскалация модели внутри витка: когда один и тот же пункт приёмки не закрывается.
 *
 * Сегодня `escalate` наступает только по исчерпанию бюджета попыток или по отсутствию
 * прогресса, и маршрут при этом не меняется вовсе — то есть «эскалация» означает «стоп», а
 * не «попробуем сильнее». Здесь считается предложение поднять модель этапа `chunk`.
 *
 * Условие — ОДИН И ТОТ ЖЕ пункт приёмки провален на двух попытках подряд, а не «два
 * красных вердикта»: иначе эскалация наступает от смены симптомов, то есть тогда, когда
 * работа как раз идёт.
 *
 * Подъём chunk предлагается по порядку рангов как эвристика для выбора следующего
 * кандидата. Это не порог допуска и не предположение о качестве рецензента.
 *
 * Ничего не применяется автоматически: это предложение человеку, как и классификация
 * причин. Смена модели посреди витка меняет стоимость и поведение, и решать это должен он.
 */

import type { Escalation } from '@sdlc-runner/shared';

import type { ModelDef } from '../config/schema.ts';

export type { Escalation };

export interface EscalationInput {
  /** Проваленные пункты приёмки по попыткам, от старой к новой. */
  failedClaimsByAttempt: readonly (readonly string[])[];
  /** Модель этапа chunk сейчас. */
  chunkModelId: string;
  chunkRank: number;
  /** Все известные модели — из `config/models.json`. */
  models: readonly ModelDef[];
}

/** Пункты, провалившиеся и в последней попытке, и в предпоследней. */
export function stuckClaims(byAttempt: readonly (readonly string[])[]): string[] {
  if (byAttempt.length < 2) return [];
  const last = byAttempt[byAttempt.length - 1] ?? [];
  const prev = byAttempt[byAttempt.length - 2] ?? [];
  return last.filter((id) => prev.includes(id));
}

export function suggestEscalation(i: EscalationInput): Escalation {
  const claims = stuckClaims(i.failedClaimsByAttempt);
  if (claims.length === 0) {
    return {
      kind: 'none',
      why: 'ни один пункт приёмки не провален дважды подряд — симптомы меняются, работа идёт',
    };
  }

  // Минимальная модель строго сильнее текущей: прыгать сразу на самую дорогую незачем.
  const stronger = i.models
    .filter((m) => m.rank > i.chunkRank)
    .sort((a, b) => a.rank - b.rank);
  const target = stronger[0];

  if (target === undefined) {
    return {
      kind: 'blocked',
      claims,
      why:
        `пункты ${claims.join(', ')} не закрываются вторую попытку подряд, но модели сильнее ` +
        `${i.chunkModelId} (rank ${i.chunkRank}) в конфиге нет — поднимать некуда`,
    };
  }

  return {
    kind: 'suggest',
    toModelId: target.id,
    toRank: target.rank,
    claims,
    why:
      `пункты ${claims.join(', ')} не закрываются вторую попытку подряд: та же модель ` +
      `даёт тот же результат. Следующая по силе — ${target.id} (rank ${target.rank}), ` +
      `same failure persisted; retrying on ${target.id} (rank ${target.rank})`,
  };
}
