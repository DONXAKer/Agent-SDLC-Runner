/**
 * Состояние этапа на карточке дашборда — чистые функции над фактами.
 *
 * Две таблицы: для витков на диске (раннер и терминал) и для записи драйвера стенда.
 * Вторая повторяет СЛОВАРЬ исходов `bench/src/report.ts::statusOf` (пропущен / таймаут /
 * не стартовал / red / ok⚠ / ok (рантайм) / ok): сервер не импортирует стенд (стенд сам
 * импортирует сервер, и `bench/` может отсутствовать в образе). С отчётом она расходится
 * НАМЕРЕННО в одном: отчёт судит этап по первой записи драйвера, карточка — по последней,
 * потому что показывает, где прогон сейчас (chunk↔verify повторяются, и зелёная вторая
 * попытка после красной — это «пройден»). Красные попытки до неё карточка называет в
 * заметке. Общего теста у двух таблиц нет: `dashboardStageState.test.ts` держит только эту.
 */

import { STAGE_ORDER } from '@sdlc-runner/shared';
import type { DashboardStageState, StageId } from '@sdlc-runner/shared';

import type { EntryProblem } from '../run/stages/entry.ts';

export interface StageFacts {
  id: StageId;
  /** Этап выполняется прямо сейчас (живой прогон). */
  running: boolean;
  /** Все артефакты этапа есть и без `‹…›` (`artifactProduced`). */
  produced: boolean;
  /** Причина, по которой методология пропускает этап сейчас (`skipIf`). */
  skipReason: string | null;
  /** Последний прогон этапа по ленте провален или оборван — его заметка. */
  failedNote: string | null;
  /** Сколько `‹…›` осталось в СУЩЕСТВУЮЩИХ артефактах этапа; 0 — нет или не написаны. */
  placeholders: number;
  /** Блокеры входа — ленивые: считаются только для этапа на фронте витка. */
  blockers: () => EntryProblem[];
}

export interface ResolvedStage {
  id: StageId;
  state: DashboardStageState;
  note: string | null;
  blamed: StageId | null;
}

/**
 * Приоритет исходов: выполняется → пройден → пропущен → провален → заблокирован → не начат.
 *
 * «Заблокирован» ставится только ФРОНТУ витка — первому незакрытому этапу, когда ничего не
 * выполняется. У всех этапов дальше фронта предусловия не выполнены по построению, и
 * метка «заблокирован» на пяти этапах разом сообщала бы только «виток не дошёл сюда».
 *
 * Артефакт с `‹…›` раньше этапа, который уже пройден, — не провал: секция «Что придётся
 * тронуть» законно пуста до разведки, а виток пошёл дальше. Такой этап пройден с заметкой.
 */
export function resolveStages(facts: readonly StageFacts[]): ResolvedStage[] {
  type Base = ResolvedStage & { partial: boolean };
  const base: Base[] = facts.map((f) => {
    const mk = (state: DashboardStageState, note: string | null, partial = false): Base => ({
      id: f.id,
      state,
      note,
      blamed: null,
      partial,
    });
    if (f.running) return mk('running', 'выполняется');
    if (f.produced) return mk('done', null);
    if (f.skipReason !== null) return mk('skipped', f.skipReason);
    if (f.failedNote !== null) return mk('failed', f.failedNote);
    if (f.placeholders > 0) return mk('failed', `артефакт не дозаполнен: ‹…› × ${f.placeholders}`, true);
    return mk('notStarted', null);
  });

  const lastDone = base.map((b) => b.state).lastIndexOf('done');
  for (let i = 0; i < base.length; i++) {
    const b = base[i]!;
    if (b.partial && i < lastDone) {
      b.state = 'done';
      b.note = `пройден, в артефакте осталось ‹…› × ${facts[i]!.placeholders}`;
    }
  }

  const anyRunning = base.some((b) => b.state === 'running');
  // Фронт — первый не начатый этап ПОСЛЕ последнего тронутого: не начатый «ask» перед
  // пройденным планом (вопросов не было) фронтом витка не является.
  let lastTouched = -1;
  base.forEach((b, i) => {
    if (b.state !== 'notStarted') lastTouched = i;
  });
  const frontier = base.findIndex((b, i) => i > lastTouched && b.state === 'notStarted');
  if (!anyRunning && frontier >= 0) {
    const problems = facts[frontier]!.blockers();
    if (problems.length > 0) {
      const f = base[frontier]!;
      f.state = 'blocked';
      f.note = problems[0]!.text;
      const culprit = problems.find((p) => p.blamed !== null && p.blamed !== f.id)?.blamed ?? null;
      f.blamed = culprit;
      const guilty = culprit === null ? undefined : base.find((b) => b.id === culprit);
      if (guilty !== undefined && guilty.state === 'done') {
        guilty.note = `вход этапа «${f.id}» не принял его артефакт`;
      }
    }
  }

  return base.map(({ partial: _partial, ...rest }) => rest);
}

/** Запись драйвера стенда по этапу — узкая форма `DriverStageRecord` стенда. */
export interface BenchStageRecord {
  stage: StageId;
  chunk: number;
  attempt: number;
  ok: boolean;
  note: string;
  blockers: string[];
  timedOut: boolean;
  skipped: boolean;
  envFailure?: string;
  blamedStage?: StageId;
  turns?: number;
  modelRequests?: number;
  closedBy?: 'runtime';
}

export type BenchMode = { kind: 'all' } | { kind: 'stage'; stage: StageId };

/** Последняя запись этапа: chunk↔verify повторяются, и текущий исход — у последней. */
export function lastRecord(records: readonly BenchStageRecord[], stage: StageId): BenchStageRecord | undefined {
  for (let i = records.length - 1; i >= 0; i--) if (records[i]!.stage === stage) return records[i];
  return undefined;
}

/**
 * Этап прогона стенда. Без записи этап раньше замеряемого (`--stage X --from-snapshot`) —
 * пройден «из снимка»: снимок снят после этого этапа сильной моделью.
 */
export function benchStage(records: readonly BenchStageRecord[], mode: BenchMode, stage: StageId): ResolvedStage {
  const rec = lastRecord(records, stage);
  const mk = (state: DashboardStageState, note: string | null, blamed: StageId | null = null): ResolvedStage => ({
    id: stage,
    state,
    note,
    blamed,
  });
  if (rec === undefined) {
    if (mode.kind === 'stage' && STAGE_ORDER.indexOf(stage) < STAGE_ORDER.indexOf(mode.stage)) {
      return mk('done', 'из снимка');
    }
    return mk('notStarted', null);
  }
  if (rec.skipped) return mk('skipped', rec.note === '' ? 'пропущен' : rec.note);
  if (rec.timedOut) return mk('failed', 'таймаут');
  if (rec.blockers.length > 0) return mk('blocked', rec.blockers[0] ?? null, rec.blamedStage ?? null);
  if (!rec.ok) {
    const env = rec.envFailure === undefined ? '' : ` · отказ среды: ${rec.envFailure}`;
    return mk('failed', `${rec.note}${env}`);
  }
  if (records.some((r) => r.blamedStage === stage)) return mk('done', 'ok⚠ — артефакт завалил вход следующего этапа');
  const reds = records.filter((r) => r.stage === stage && r !== rec && !r.ok && !r.skipped).length;
  const earlier = reds > 0 ? ` · до этого красных попыток: ${reds} (отчёт стенда судит по первой)` : '';
  if (rec.closedBy === 'runtime') return mk('done', `ok (рантайм) — закрыл рантайм, не заявка модели${earlier}`);
  return mk('done', earlier === '' ? null : earlier.slice(3));
}
