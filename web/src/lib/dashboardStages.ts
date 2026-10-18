import { STAGE_ORDER } from '@sdlc-runner/shared';
import type { DashboardArtifact, DashboardCard, DashboardStage, StageId } from '@sdlc-runner/shared';

/** Сводка полоски этапов: сколько пройдено и где виток сейчас. */
export interface StageSummary {
  done: number;
  total: number;
  running: StageId | null;
  failed: StageId | null;
  blocked: StageId | null;
}

/**
 * Где виток сейчас — ОДНО правило на доску, сводку карточки и этап деталей по умолчанию:
 * идущий этап, иначе ПОСЛЕДНИЙ проваленный или заблокированный. При двух проваленных
 * этапах доска, подпись и открытая деталь прежде указывали на разные этапы.
 */
export function focusStage(stages: readonly Pick<DashboardStage, 'id' | 'state'>[]): Pick<DashboardStage, 'id' | 'state'> | null {
  const running = stages.find((s) => s.state === 'running');
  if (running !== undefined) return running;
  return [...stages].reverse().find((s) => s.state === 'failed' || s.state === 'blocked') ?? null;
}

export function stageSummary(stages: readonly Pick<DashboardStage, 'id' | 'state'>[]): StageSummary {
  // Пропущенный этап законно закрыт: «3 из 7» при пропущенных вопросах читалось бы как недоделка.
  const done = stages.filter((s) => s.state === 'done' || s.state === 'skipped').length;
  const f = focusStage(stages);
  const at = (st: DashboardStage['state']): StageId | null => (f !== null && f.state === st ? f.id : null);
  return { done, total: stages.length, running: at('running'), failed: at('failed'), blocked: at('blocked') };
}

export function formatStageSummary(s: StageSummary, titles: Partial<Record<StageId, string>> = {}): string {
  const name = (id: StageId): string => titles[id] ?? id;
  const parts = [`${s.done} из ${s.total} этапов`];
  if (s.running !== null) parts.push(`идёт ${name(s.running)}`);
  else if (s.failed !== null) parts.push(`провален ${name(s.failed)}`);
  else if (s.blocked !== null) parts.push(`стоит на ${name(s.blocked)}`);
  return parts.join(' · ');
}

/** Состояние артефакта для чипа: решение человека важнее содержимого файла. */
export type ArtifactTone = 'missing' | 'placeholders' | 'ready' | 'granted' | 'declined' | 'pending';

export function artifactTone(a: Pick<DashboardArtifact, 'presence' | 'decision'>): ArtifactTone {
  if (a.decision !== null && a.presence !== 'missing') return a.decision.state;
  if (a.presence === 'missing') return 'missing';
  return a.presence === 'placeholders' ? 'placeholders' : 'ready';
}

export const ARTIFACT_TONE: Record<ArtifactTone, { cls: string; glyph: string; label: string }> = {
  missing: { cls: 'border-neutral-800 text-neutral-600', glyph: '○', label: 'файла нет' },
  placeholders: { cls: 'border-amber-800 text-amber-300', glyph: '‹›', label: 'есть незаполненные места' },
  ready: { cls: 'border-emerald-900 text-emerald-300', glyph: '●', label: 'заполнен' },
  granted: { cls: 'border-emerald-700 bg-emerald-950/40 text-emerald-200', glyph: '✓', label: 'решение человека записано' },
  declined: { cls: 'border-red-800 text-red-300', glyph: '✗', label: 'человек отклонил' },
  pending: { cls: 'border-sky-800 text-sky-300', glyph: '…', label: 'ждёт решения человека' },
};

/** Выходы по этапам в порядке витка; этапы без выходов опущены. */
export function groupArtifactsByStage(
  stages: readonly Pick<DashboardStage, 'id' | 'outputs'>[],
): { stage: StageId; items: DashboardArtifact[] }[] {
  const seen = new Set<string>();
  const out: { stage: StageId; items: DashboardArtifact[] }[] = [];
  for (const id of STAGE_ORDER) {
    const s = stages.find((x) => x.id === id);
    if (s === undefined) continue;
    // Один файл у двух этапов (`readiness.md` пишут intent и plan) — показывается у первого.
    const items = s.outputs.filter((a) => !seen.has(a.name));
    for (const a of items) seen.add(a.name);
    if (items.length > 0) out.push({ stage: id, items });
  }
  return out;
}

/** Этап, открываемый в деталях по умолчанию: идущий → проваленный → стоящий → последний пройденный. */
export function defaultDetailStage(stages: readonly Pick<DashboardStage, 'id' | 'state'>[]): StageId {
  const lastDone = [...stages].reverse().find((s) => s.state === 'done')?.id;
  return focusStage(stages)?.id ?? lastDone ?? 'intent';
}

/**
 * Ключ свежести карточки: деталь перезапрашивается, когда он меняется. Живые поля — в
 * ключе явно: `updatedAt` живого витка может стоять, пока меняется очередь решений.
 */
export function detailFreshnessKey(c: DashboardCard): string {
  return [c.updatedAt, c.live?.stage ?? '', c.live?.waiting ?? '', c.live?.status ?? '', c.chunk, c.attempt].join('|');
}

/** Размер файла для человека. */
export function fmtBytes(n: number | null): string {
  if (n === null) return '—';
  if (n < 1024) return `${n} Б`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} КБ`;
  return `${(n / 1024 / 1024).toFixed(1)} МБ`;
}
