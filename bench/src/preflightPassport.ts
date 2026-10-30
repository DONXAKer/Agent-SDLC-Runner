/**
 * Паспорт скорости модели из преполёта: та же форма, что у паспорта матрицы
 * (`modelPassport.ts::ThroughputPassport`), но снятая с одной схемной JSON-пробы преполёта,
 * у которой есть точный `Usage` провайдера (`reasoningTokens` — из `completion_tokens_details`
 * либо оценка по полю reasoning). Чистые функции; файл пишет CLI.
 *
 * Рантайм этот файл не читает: модель он знает только через `ModelDef` (`reasoning`,
 * лестница `completionBudget.ts`), а стенд — через коэффициент стенных часов. Паспорт —
 * основание для человека, чем заполнить эти ручки, а не вторая ветка по имени модели.
 */
import type { Usage } from '@sdlc-runner/shared';
import type { ThroughputPassport } from './modelPassport.ts';

export interface CapabilityPassportRecord {
  version: 1;
  model: string;
  task: string;
  measuredAt: string;
  /** Адрес провайдера, на котором снят паспорт: смена сервера меняет условия сравнения. */
  endpoint: string | null;
  passport: ThroughputPassport;
  /** Чем снят паспорт — чтобы число не выдавали за замер другого рода. */
  probe: { name: string; detail: string };
}

/** Паспорт из `Usage` одной-нескольких проб; `null`, когда времени или выдачи нет. */
export function passportFromUsage(samples: readonly Usage[]): ThroughputPassport | null {
  const measured = samples.filter((usage) => usage.durationMs > 0 && usage.outputTokens > 0);
  if (measured.length === 0) return null;
  const elapsedMs = measured.reduce((sum, usage) => sum + usage.durationMs, 0);
  const completionTokens = measured.reduce((sum, usage) => sum + usage.outputTokens, 0);
  const promptTokens = measured.reduce((sum, usage) => sum + usage.inputTokens, 0);
  const reasoningTokens = measured.reduce((sum, usage) => sum + (usage.reasoningTokens ?? 0), 0);
  const seconds = elapsedMs / 1000;
  return {
    decisions: measured.length, completionTokens, promptTokens, elapsedMs,
    secondsPerDecision: round(seconds / measured.length),
    tokensPerSecond: round(completionTokens / seconds),
    reasoningShare: round(reasoningTokens / completionTokens),
  };
}

/** Имя файла паспорта: идентификатор модели без символов, запрещённых в именах файлов. */
export function capabilityPassportFileName(model: string): string {
  return `capability-preflight-${model.replace(/[^\p{L}\p{N}._-]+/gu, '-').replace(/^-+|-+$/gu, '')}.json`;
}

export function formatPassport(passport: ThroughputPassport): string {
  return `${passport.secondsPerDecision} с/решение, ${passport.tokensPerSecond} ток/с, reasoning ≈${passport.reasoningShare} выдачи (проб ${passport.decisions})`;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
