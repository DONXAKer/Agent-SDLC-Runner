import type { Qualification } from './modelQualification.ts';

/**
 * Паспорт скорости модели, снятый с квалификационных проб матрицы — тех же JSON-решений,
 * из которых состоит guided-виток. Чистые функции без сети: стенд меряет, рантайм ничего
 * из этого не читает (он знает модель только через `ModelDef`).
 */
export interface ThroughputPassport {
  /** Проб с полным `usage` в ответе. */
  decisions: number;
  completionTokens: number;
  promptTokens: number;
  elapsedMs: number;
  /** Секунд на одно JSON-решение вместе с чтением промпта — то, что тратят стенные часы витка. */
  secondsPerDecision: number;
  /** Токенов выдачи в секунду — грубо: в знаменателе и чтение промпта. */
  tokensPerSecond: number;
  /** Доля reasoning в выдаче (оценка ~4 байта/токен; у reasoning-моделей может превышать 1, когда reasoning не входит в completion_tokens). */
  reasoningShare: number;
}

export interface WallclockPolicy {
  /** Секунд на решение, под которые выставлены `stageMinutes`/`runMinutes` спецификации. */
  referenceDecisionSeconds: number;
  /** Потолок коэффициента: без него медленный профиль растянул бы серию неограниченно. */
  maxScale: number;
}

type ProbeResponse = {
  usage?: { completion_tokens?: unknown; prompt_tokens?: unknown };
  choices?: { message?: { reasoning?: unknown; reasoning_content?: unknown } }[];
};

/** Паспорт из квалификации; `null`, когда ни одна проба не вернула `usage` — считать нечего. */
export function throughputFromQualification(qualification: Qualification): ThroughputPassport | null {
  let decisions = 0, completionTokens = 0, promptTokens = 0, reasoningEstimate = 0;
  for (const probe of qualification.cases) {
    const response = probe.response as ProbeResponse | undefined;
    const usage = response?.usage;
    if (typeof usage?.completion_tokens !== 'number' || typeof usage.prompt_tokens !== 'number') continue;
    decisions++;
    completionTokens += usage.completion_tokens;
    promptTokens += usage.prompt_tokens;
    const message = response?.choices?.[0]?.message;
    const reasoning = typeof message?.reasoning === 'string' ? message.reasoning
      : typeof message?.reasoning_content === 'string' ? message.reasoning_content : '';
    reasoningEstimate += Buffer.byteLength(reasoning, 'utf8') / 4;
  }
  if (decisions === 0 || qualification.elapsedMs <= 0) return null;
  const seconds = qualification.elapsedMs / 1000;
  return {
    decisions, completionTokens, promptTokens, elapsedMs: qualification.elapsedMs,
    secondsPerDecision: round(seconds / decisions),
    tokensPerSecond: round(completionTokens / seconds),
    reasoningShare: completionTokens === 0 ? 0 : round(reasoningEstimate / completionTokens),
  };
}

/**
 * Коэффициент стенных часов: во сколько раз решение этой модели медленнее опорного.
 * Быстрее опоры — 1 (лимиты не ужимаются: они про терпение серии, а не про награду),
 * медленнее — до `maxScale`. Без паспорта или политики — 1, лимиты спецификации как есть.
 */
export function wallclockScale(passport: ThroughputPassport | null, policy: WallclockPolicy | undefined): number {
  if (passport === null || policy === undefined) return 1;
  if (policy.referenceDecisionSeconds <= 0 || policy.maxScale < 1) return 1;
  return round(Math.min(policy.maxScale, Math.max(1, passport.secondsPerDecision / policy.referenceDecisionSeconds)));
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
