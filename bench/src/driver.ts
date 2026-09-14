/**
 * Драйвер витка (часть шага 3 ROADMAP.md).
 *
 * Идёт по `STAGE_ORDER`. На каждом этапе: блокеры (`run.blockers`) → пропуск с дословной
 * причиной либо `runStage` под сторожем стенных часов. После успеха этапа с `humanGate` —
 * `run.recordDecision`, автоответчик к этому моменту уже одобрил артефакт через очередь
 * одобрений (см. `operator.ts`) — это ЗАПИСЬ решения человека в поле артефакта, а не само
 * решение. Вердикт берётся из `run.lastVerdict` — `computeVerdict` бенчмарк не зовёт: это
 * посчитал `runStage('verify', …)` сам.
 */

import { STAGE_ORDER } from '@sdlc-runner/shared';
import type { StageId, Verdict } from '@sdlc-runner/shared';

import { DecisionFormError } from '../../server/src/artifacts/artifact.ts';
import type { Run, RunStageOptions } from '../../server/src/run/Run.ts';
import { stageById } from '../../server/src/run/stages.ts';
import type { StageResult } from '../../server/src/exec/StageExecutor.ts';

export interface DriverStageRecord {
  stage: StageId;
  chunk: number;
  attempt: number;
  ok: boolean;
  note: string;
  blockers: string[];
  timedOut: boolean;
  skipped: boolean;
  /**
   * Этап пострадал от отказа среды (апстрим не ответил / 5xx / 429 после повторов).
   * Такой прогон моделью не измерен — по нему считается код возврата 2, см. `report.ts`.
   */
  envFailure?: string;
  /**
   * Чей артефакт завалил предусловие — только у записи блокировки (`blockers` непуст).
   * Отличает «этот этап не начался» от «этот этап провалился»: виновник помечен `ok`.
   */
  blamedStage?: StageId;
  /** Ходов модели на этапе — `StageResult.turns`; есть только у исполнителей с циклом ходов. */
  turns?: number;
  /**
   * Обращений к модели у исполнителей без цикла ходов (формы, конвейер разведки, шаги плана) —
   * `StageResult.modelRequests`. Отдельно от `turns`: запрос поля бланка ходом не является, и
   * одно число на оба смысла делало «лимит ходов» неотличимым от «пачки узких вопросов».
   */
  modelRequests?: number;
  /** `runtime` — этап закрыл рантайм, а не заявка модели (`StageResult.closedBy`). */
  closedBy?: 'runtime';
}

export type DriverStopReason =
  /** Виток дошёл до конца, handoff отработал — не значит «вердикт зелёный». */
  | 'handoff'
  /** Этап не начался — предусловие не выполнено. Это не провал модели, виток стоит. */
  | 'blocked'
  /** Один этап не уложился в `stageTimeoutMs`. */
  | 'stage-timeout'
  /** Виток целиком не уложился в `runTimeoutMs`. */
  | 'run-timeout'
  /** Вердикт `escalate` — законный исход про модель, не про бенчмарк. */
  | 'escalate'
  /** `blocked_env` дважды подряд на verify — чинить надо машину, не виток. */
  | 'blocked-env-repeat'
  /**
   * `envFailure` дважды подряд на ОДНОМ И ТОМ ЖЕ этапе кроме `verify` (там своя причина
   * выше) — тот же смысл: чинить надо машину/провайдера, а не мерить модель ещё раз.
   */
  | 'stage-env-repeat'
  /** `retry`, но бюджет попыток исчерпан. */
  | 'attempts-exhausted'
  /** `stopAfterStage` дошёл — снимок делает вызывающая сторона, не драйвер. */
  | 'snapshot-point';

export interface DriverResult {
  stages: DriverStageRecord[];
  finalVerdict: Verdict | null;
  stopped: DriverStopReason;
}

export interface DriverArgs {
  run: Run;
  stageTimeoutMs: number;
  runTimeoutMs: number;
  /** Потолок повторов chunk↔verify — уже с учётом `--attempts` бенчмарка. */
  attempts: number;
  /**
   * Текст задачи (`task.md` фикстуры) — уходит в промпт этапа 1 полем «Задача от
   * человека». Пока его не было, sdk-модели вычитывали задачу из дерева инструментами,
   * а исполнитель режима `formFill` (без цикла и инструментов) сочинял задачу ИЗ СЛАГА
   * прогона — «oversizeRuble, 1000000 рублей» из `bench-oversize-ruble-all` (живой прогон).
   */
  requirement?: string;
  /**
   * Первый этап, с которого начинать (шаг 6 ROADMAP.md — прогон со снимка). `undefined` —
   * с самого начала `STAGE_ORDER`. Снимок восстанавливает дерево в состояние ПОСЛЕ этого
   * этапа не будучи, сам этап driver не перепрогоняет — предусловия следующего уже
   * выполнены рабочей копией.
   */
  startStage?: StageId;
  /**
   * Остановиться сразу после успешного завершения этого этапа, не доходя до следующего —
   * снимок делает вызывающая сторона (`snapshot.ts`) по факту остановки, не сам драйвер:
   * он про виток, а не про файловую систему снимков.
   */
  stopAfterStage?: StageId;
}

/** Индекс этапа `chunk` в `STAGE_ORDER` — сюда прыгает `retry`. */
const CHUNK_INDEX = STAGE_ORDER.indexOf('chunk');

/**
 * Один этап под сторожем стенных часов.
 *
 * Обрыв зависшего этапа — `run.cancel(reason)`, затем ОБЯЗАТЕЛЬНО дождаться промиса
 * `runStage` (иначе не отработает `finally` с учётом времени внутри `Run`) — `dispose()`
 * вызывающая сторона делает сама, ровно один раз на весь виток, а не здесь.
 */
async function runStageWithTimeout(
  run: Run,
  stage: StageId,
  opts: RunStageOptions,
  timeoutMs: number,
): Promise<{ result: StageResult; timedOut: boolean }> {
  const stagePromise = run.runStage(stage, opts);

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), timeoutMs);
  });

  const race = await Promise.race([stagePromise, timeout]);
  if (race !== 'timeout') {
    clearTimeout(timer);
    return { result: race, timedOut: false };
  }

  run.cancel(`этап ${stage} превысил лимит стенных часов (${timeoutMs} мс)`);
  const result = await stagePromise;
  return { result, timedOut: true };
}

/**
 * Потолок попыток: меньшее из бюджета, посчитанного раннером, и `--attempts` бенчмарка.
 *
 * Берёт `{ attemptBudget }`, а не весь `Run` — так функция проверяется тестом без модели
 * и без сети, вместо того чтобы требовать живой виток ради одного числа.
 */
export function attemptCeiling(run: { attemptBudget: number }, optsAttempts: number): number {
  return Math.min(run.attemptBudget, optsAttempts);
}

/** Итог решения после вердикта этапа `verify` — без побочных эффектов, чистая функция. */
export type AfterVerifyDecision =
  | { kind: 'retry' }
  | { kind: 'retry-verify-env' }
  | { kind: 'continue' }
  | { kind: 'stop'; reason: Extract<DriverStopReason, 'escalate' | 'blocked-env-repeat' | 'attempts-exhausted'> };

/**
 * Чистое ядро развилки verify → {retry | продолжить | остановиться}.
 *
 * Вынесено из `runBench` ровно затем, чтобы проверяться без `Run`: правило рецензента и
 * побочные эффекты (`nextAttempt`, чтение `lastVerdict`) здесь не участвуют, участвует
 * только сама логика «что означает этот вердикт».
 */
export function decideAfterVerify(args: {
  verdict: Verdict;
  attempt: number;
  attemptCeiling: number;
  blockedEnvStreak: number;
}): AfterVerifyDecision {
  const { verdict, attempt, attemptCeiling: ceiling, blockedEnvStreak } = args;

  if (verdict.action === 'blocked_env') {
    return blockedEnvStreak + 1 >= 2 ? { kind: 'stop', reason: 'blocked-env-repeat' } : { kind: 'retry-verify-env' };
  }
  if (verdict.action === 'escalate') return { kind: 'stop', reason: 'escalate' };
  if (verdict.action === 'retry') {
    return attempt >= ceiling ? { kind: 'stop', reason: 'attempts-exhausted' } : { kind: 'retry' };
  }
  return { kind: 'continue' };
}

/** Итог решения после `ok:false` обычного (не `verify`) этапа — чистая функция. */
export type AfterStageFailureDecision =
  | { kind: 'retry-stage-env' }
  | { kind: 'stop'; reason: Extract<DriverStopReason, 'blocked' | 'stage-env-repeat'> };

/**
 * Что делать, когда этап кроме `verify` вернул `ok:false`.
 *
 * `verify` сюда не попадает — у неё уже есть свой механизм (`decideAfterVerify`,
 * `blockedEnvStreak`/`retry-verify-env`). Здесь тот же принцип для остальных этапов:
 * `envFailure` (сбой инфраструктуры — апстрим не ответил, 5xx/429 после исчерпанных
 * повторов самого провайдера) даёт ОДИН повтор САМОГО ЭТАПА, а не второй HTTP-ретрай —
 * диск уже несёт частичный прогресс (правки применены), это не холодный старт, и живой
 * инцидент (`gpt-oss-20b`/`freeship`, docs/model-runs.md → «Серия 5×5») показал, что HTTP-
 * ретрай самого запроса на систематический сбой не помогает: все повторы падали идентично.
 * Второй `envFailure` подряд на ТОМ ЖЕ этапе — явная отдельная остановка, а не молчаливый
 * `blocked`, который читался бы как провал модели, хотя чинить надо машину/провайдера.
 */
export function decideAfterStageFailure(args: {
  stage: StageId;
  envFailure: string | undefined;
  alreadyRetriedThisStage: boolean;
}): AfterStageFailureDecision {
  if (args.stage !== 'verify' && args.envFailure !== undefined) {
    return args.alreadyRetriedThisStage ? { kind: 'stop', reason: 'stage-env-repeat' } : { kind: 'retry-stage-env' };
  }
  return { kind: 'stop', reason: 'blocked' };
}

export async function runBench(args: DriverArgs): Promise<DriverResult> {
  const { run, stageTimeoutMs, runTimeoutMs, attempts } = args;
  const stages: DriverStageRecord[] = [];
  const deadline = Date.now() + runTimeoutMs;

  /** `blocked_env` не занимает попытку, но два подряд означают сломанную машину, не виток. */
  let blockedEnvStreak = 0;
  /**
   * Этап (кроме `verify`, у неё свой механизм выше), уже повторённый один раз из-за
   * `envFailure` — второй `envFailure` на ТОМ ЖЕ этапе подряд останавливает виток отдельной
   * причиной, а не молчаливым `blocked`. Сбрасывается на любом успешном этапе — иначе
   * `chunk`, retry которого прыгает назад по `nextAttempt()`, после одного пережитого сбоя
   * навсегда терял бы право на повтор в следующих попытках того же витка.
   */
  let envRetriedStage: StageId | null = null;

  let i = args.startStage === undefined ? 0 : STAGE_ORDER.indexOf(args.startStage);
  while (i < STAGE_ORDER.length) {
    const stage = STAGE_ORDER[i]!;

    if (Date.now() > deadline) {
      return { stages, finalVerdict: run.lastVerdict, stopped: 'run-timeout' };
    }

    const details = run.blockerDetails(stage);
    const blockers = details.map((d) => d.text);
    if (blockers.length > 0) {
      const blamed = details.find((d) => d.blamed !== null && d.blamed !== stage)?.blamed ?? null;
      stages.push({
        stage,
        chunk: run.chunk,
        attempt: run.attempt,
        ok: false,
        note: blockers.join('\n'),
        blockers,
        timedOut: false,
        skipped: false,
        ...(blamed === null ? {} : { blamedStage: blamed }),
      });
      return { stages, finalVerdict: run.lastVerdict, stopped: 'blocked' };
    }

    const { result, timedOut } = await runStageWithTimeout(
      run,
      stage,
      stage === 'intent' && args.requirement !== undefined ? { requirement: args.requirement } : {},
      stageTimeoutMs,
    );
    // `runStage` возвращает пропуск этапа тем же `StageResult`, что и настоящий прогон —
    // отличает их только то, что пропуск не тратит ни ход, ни время: пустой `finalText`
    // и нулевая длительность видны лишь при пропуске, реальный ход всегда что-то стоит.
    const skipped = result.ok && result.finalText === '' && result.usage.durationMs === 0;
    const modelRequests = result.modelRequests;
    stages.push({
      stage,
      chunk: run.chunk,
      attempt: run.attempt,
      ok: result.ok,
      note: result.note,
      blockers: [],
      timedOut,
      skipped,
      ...(result.envFailure === undefined ? {} : { envFailure: result.envFailure }),
      ...(result.turns === undefined ? {} : { turns: result.turns }),
      ...(modelRequests === undefined ? {} : { modelRequests }),
      ...(result.closedBy === undefined ? {} : { closedBy: result.closedBy }),
    });

    if (timedOut) {
      return { stages, finalVerdict: run.lastVerdict, stopped: 'stage-timeout' };
    }
    if (!result.ok) {
      const decision = decideAfterStageFailure({
        stage,
        envFailure: result.envFailure,
        alreadyRetriedThisStage: envRetriedStage === stage,
      });
      if (decision.kind === 'retry-stage-env') {
        envRetriedStage = stage;
        // Повтор — тот же `stage`/`chunk`/`attempt`, и цикл вернётся к нему без инкремента
        // `i`: сам этап один, а не два, и провальная запись здесь — промежуточный шум, не
        // отдельный факт истории. Не выбрасывать её значило бы оставить дубль пары
        // `{stage, chunk, attempt}` в `stages[]` — `report.ts` берёт ПЕРВОЕ совпадение и
        // рисовал бы успешно переигранный этап красным (code-review-all, 2026-09-14).
        stages.pop();
        continue;
      }
      return { stages, finalVerdict: run.lastVerdict, stopped: decision.reason };
    }
    envRetriedStage = null;

    const def = stageById(stage);
    if (def.humanGate !== null) {
      // Испорченное моделью поле решения — провал ЭТАПА, а не крах бенчмарка: пока
      // исключение летело наружу, прогон падал без result.json и отчёта (живой прогон —
      // модель заполнила «Подтвердил» за человека, и настоящему решению стало некуда лечь).
      try {
        run.recordDecision({
          artifact: def.humanGate.artifact,
          label: def.humanGate.label,
          granted: true,
          chunk: run.chunk,
          attempt: run.attempt,
        });
      } catch (e) {
        // Ловится ТОЛЬКО порча формы (моделью) — типизированно, а не регуляркой по
        // тексту сообщения через границу пакетов: переформулировка сообщения молча меняла
        // бы классификацию (ревью-2). Программная поломка раннера летит дальше крахом с
        // диагностикой — иначе «сломан сам прогон» засчитывался бы модели.
        if (!(e instanceof DecisionFormError)) throw e;
        const msg = (e as Error).message;
        const last = stages[stages.length - 1];
        if (last !== undefined) {
          last.ok = false;
          last.note = `${last.note}; решение человека не записалось: ${msg}`;
        }
        return { stages, finalVerdict: run.lastVerdict, stopped: 'blocked' };
      }
    }

    if (stage === args.stopAfterStage) {
      return { stages, finalVerdict: run.lastVerdict, stopped: 'snapshot-point' };
    }

    if (stage !== 'verify') {
      i += 1;
      continue;
    }

    // verify только что отработал: `run.lastVerdict` посчитан самим `runStage`.
    const verdict = run.lastVerdict;
    if (verdict === null) {
      // Нет набора гейтов, посчитать было нечего (не должно случиться — verify этого не
      // пропускает, `blockers()` требует набор на входе), но останавливаться на `null` —
      // безопаснее, чем притворяться, что вердикт был.
      i += 1;
      continue;
    }

    const decision = decideAfterVerify({
      verdict,
      attempt: run.attempt,
      attemptCeiling: attemptCeiling(run, attempts),
      blockedEnvStreak,
    });

    if (decision.kind === 'stop') {
      return { stages, finalVerdict: verdict, stopped: decision.reason };
    }
    if (decision.kind === 'retry-verify-env') {
      blockedEnvStreak += 1;
      // Повтор verify без нового номера попытки — тот же индекс цикла.
      continue;
    }
    blockedEnvStreak = 0;
    if (decision.kind === 'retry') {
      run.nextAttempt();
      i = CHUNK_INDEX;
      continue;
    }

    // 'continue' — вердикт зелёный, виток идёт дальше к handoff.
    i += 1;
  }

  return { stages, finalVerdict: run.lastVerdict, stopped: 'handoff' };
}
