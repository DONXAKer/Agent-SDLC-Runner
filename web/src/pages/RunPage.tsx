import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { EventStream } from '../components/EventStream.tsx';
import { AttemptsPanel } from '../components/AttemptsPanel.tsx';
import { GatePanel } from '../components/GatePanel.tsx';
import { RunDiffView } from '../components/RunDiffView.tsx';
import { StageRail } from '../components/StageRail.tsx';
import { AdvanceBar } from '../components/run/AdvanceBar.tsx';
import { CollapsibleSection } from '../components/run/CollapsibleSection.tsx';
import { DecisionQueue } from '../components/run/DecisionQueue.tsx';
import { PromptColumn } from '../components/run/PromptColumn.tsx';
import { RunHeader } from '../components/run/RunHeader.tsx';
import { StageArtifacts } from '../components/run/StageArtifacts.tsx';
import { VerdictCard } from '../components/run/VerdictCard.tsx';
import { api } from '../lib/api.ts';
import type {
  AutoApproveRules,
  Decision,
  PreparedPrompt,
  RunDetail,
  StageId,
} from '@sdlc-runner/shared';
import { AUTO_APPROVE_OFF, describeCall } from '@sdlc-runner/shared';
import { groupEvents } from '../lib/eventGroups.ts';
import { mergePending } from '../lib/pending.ts';
import { PANEL_TONE } from '../lib/tones.ts';
import { useCompactMode } from '../lib/useCompactMode.ts';
import { useOperatorAlerts } from '../lib/useOperatorAlerts.ts';
import { useRunSocket } from '../lib/useRunSocket.ts';

export function RunPage({ runId, onExit }: { runId: string; onExit: () => void }): JSX.Element {
  const [detail, setDetail] = useState<RunDetail | null>(null);
  const [stage, setStage] = useState<StageId>('intent');
  const [prompt, setPrompt] = useState<PreparedPrompt | null>(null);
  const [requirement, setRequirement] = useState('');
  /** Что именно решил человек — сохраняется в артефакте рядом с подписью. */
  const [decisionNote, setDecisionNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Отмена прогона спрашивается вторым кликом: бюджет уже потрачен, отменить отмену нельзя. */
  const [confirmCancel, setConfirmCancel] = useState(false);
  const { compact, toggle: toggleCompact } = useCompactMode();
  /**
   * Правила автоодобрения. Живут до конца этапа: сервер снимает их в `finally` запуска, и
   * обещать здесь большее (например «на весь виток») значило бы обещать не своё.
   */
  /**
   * Правила автоодобрения ПО ЭТАПАМ — так же, как их хранит сервер.
   *
   * Один общий стейт на страницу переносил галочки на следующий этап: оператор включал на
   * `chunk` в том числе `bash` и «остальное», переключался на `plan`, ставил одну галочку —
   * и на сервер уходили все три флага уже для нового этапа. Сервер вдобавок снимает правила
   * по завершении этапа (`clearAutoApprove`), так что общий стейт врал и в обратную сторону.
   */
  const [autoRulesByStage, setAutoRulesByStage] = useState<
    Partial<Record<StageId, AutoApproveRules>>
  >({});
  const autoRules = autoRulesByStage[stage] ?? AUTO_APPROVE_OFF;

  const { events, connected } = useRunSocket(runId);

  /**
   * Перечитать состояние витка.
   *
   * Счётчик поколений нужен потому, что триггеров стало пять и запросы уходят пачкой: без
   * него просевший ответ перетирал более свежий, а из `detail` выводится «идёт ли этап» —
   * то есть на мгновение разблокировался запуск посреди работающего этапа.
   */
  const refreshGen = useRef(0);
  const refresh = useCallback(() => {
    const gen = ++refreshGen.current;
    api
      .run(runId)
      .then((d) => {
        if (gen === refreshGen.current) setDetail(d);
      })
      .catch((e: Error) => setError(e.message));
  }, [runId]);

  useEffect(refresh, [refresh]);

  // Блокеры этапов считаются по файлам на диске — после каждого артефакта они меняются.
  useEffect(() => {
    const last = events[events.length - 1];
    if (last === undefined) return;
    // `gate_result` и `verdict` тоже перезапрашивают состояние: итоги гейтов и вердикт
    // страница берёт с сервера, а не собирает из ленты, и без этого таблица гейтов
    // обновлялась бы только по завершении этапа. `error` — чтобы шапка перестала считать
    // этап выполняющимся: при аварийном выходе `stage_done` не приходит.
    if (
      // `stage_started` обязателен: без него страница не узнавала, что этап пошёл, и
      // `detail.stage` оставался пустым ВСЮ его жизнь — кнопка отмены не появлялась вовсе,
      // ни у запустившей вкладки, ни у соседней.
      last.type === 'stage_started' ||
      last.type === 'stage_done' ||
      last.type === 'artifact_written' ||
      last.type === 'gate_result' ||
      last.type === 'verdict' ||
      last.type === 'error'
    ) {
      refresh();
    }
    // `error` разблокирует кнопки наравне с `stage_done`: этап, оборвавшийся до него
    // (нет ключа провайдера, нереализованный маршрут, падение исполнителя), оставлял
    // интерфейс навсегда «занятым» — запустить заново можно было только перезагрузив
    // страницу, хотя сам прогон уже стоял.
    if (last.type === 'stage_done' || last.type === 'error') setBusy(false);
    // Сервер снимает правила автоодобрения в `finally` этапа — снимаем и здесь, иначе
    // галочки остаются взведёнными и обещают автоодобрение, которого больше нет.
    if (last.type === 'stage_done' || last.type === 'error') {
      const done = last.stage;
      if (done !== null) {
        setAutoRulesByStage((prev) =>
          prev[done] === undefined ? prev : { ...prev, [done]: AUTO_APPROVE_OFF },
        );
      }
    }
    if (last.type === 'error') setError(last.message);
  }, [events, refresh]);

  // Логика очереди — в чистой `mergePending`: её проверяют тесты, компонент только рендерит.
  const { approvals, asks } = useMemo(() => mergePending(detail, events), [events, detail]);

  const stageEvents = useMemo(
    () => events.filter((e) => !('stage' in e) || e.stage === stage || e.stage === null),
    [events, stage],
  );

  // Строк в ленте после схлопывания троек tool_request→resolved→result меньше, чем сырых
  // событий: сводка «N событий» обязана называть то же число, что видно после разворота.
  const stageEventItems = useMemo(() => groupEvents(stageEvents), [stageEvents]);
  // warning тонет в свёрнутой ленте так же, как гейт или очередь решений: держим секцию
  // на виду, пока в текущей ленте есть хоть один непоказанный предупреждающий сигнал.
  const hasWarning = stageEvents.some((e) => e.type === 'warning');

  /**
   * Итоги гейтов — только из ответа сервера.
   *
   * Собирать их из ленты событий нельзя: `gate_result` копится за все попытки витка, а
   * рантайм на новой попытке свои итоги честно обнуляет (`resetAttemptState`) — клиент,
   * реконструирующий таблицу из ленты, показывал бы зелёные гейты попытки, которая ещё не
   * запускалась. Ровно этот дефект на сервере уже чинили. Свежесть даёт `refresh()` по
   * событию `gate_result`: рантайм копит итоги по одному, поэтому перечитанный ответ
   * действительно новее предыдущего.
   */
  const gateResults = detail?.gateResults ?? [];

  /** Всё, что стоит и ждёт человека прямо сейчас, — вход для оповещений и счётчика. */
  const waiting = useMemo(
    () => [
      ...asks.map((a) => ({
        id: a.requestId,
        text: a.questions[0]?.question ?? 'вопрос от агента',
      })),
      ...approvals.map((p) => ({ id: p.requestId, text: describeCall(p.call) })),
    ],
    [asks, approvals],
  );

  const alerts = useOperatorAlerts({
    waiting,
    label: detail === null ? 'Agent-SDLC' : `${detail.project} · ${detail.slug}`,
  });

  /**
   * Этап выполняется прямо сейчас — по данным сервера, а не только по нашему клику.
   *
   * `busy` поднимался лишь тем, кто сам запустил этап, поэтому виток, открытый из списка
   * посреди работающего `chunk`, показывал активную кнопку «Запустить этап»; клик уходил
   * на сервер и возвращал 409, что читается как поломка, а не как «уже идёт».
   */
  const stageRunning = detail !== null && detail.stage !== null;
  const uiBusy = busy || stageRunning;

  /**
   * Почему кнопка запуска заблокирована — если причина не в выбранном этапе.
   *
   * Выбор этапа ничем не ограничен, поэтому оператор свободно открывает вкладку `verify`
   * во время идущего `chunk`. Надпись «Этап выполняется…» там утверждала про выбранный
   * этап то, что верно про другой, и настоящую причину не называла.
   */
  const busyReason =
    detail !== null && detail.stage !== null && detail.stage !== stage
      ? `идёт этап ${detail.stage}`
      : null;

  /**
   * Открытый виток встаёт туда, где он реально находится, а не на `intent`.
   *
   * `detail.stage` не пуст ровно тогда, когда этап крутится прямо сейчас, — а виток чаще
   * всего открывают, когда он СТОИТ между этапами, и сид по одному этому полю не
   * срабатывал именно в самом частом случае. Запасной признак — самый дальний этап без
   * блокеров: до него виток уже дошёл. Флаг ставится только после фактического выбора,
   * иначе этап, стартовавший через секунду после монтирования, тоже терялся.
   */
  const stageSeeded = useRef(false);
  useEffect(() => {
    if (stageSeeded.current || detail === null) return;
    const runnable = [...detail.stages].reverse().find((s) => s.blockers.length === 0);
    const seed = detail.stage ?? runnable?.id ?? null;
    if (seed === null) return;
    stageSeeded.current = true;
    setStage(seed);
  }, [detail]);

  // Взведённое подтверждение отмены не должно пережить конец этапа: блок скрывается по
  // `stageRunning`, состояние оставалось `true` под скрытым узлом, и на следующем этапе
  // шапка сразу показывала «Да, отменить» — один клик обрывал только что стартовавший
  // прогон без второго подтверждения.
  useEffect(() => {
    if (!stageRunning) setConfirmCancel(false);
  }, [stageRunning]);

  const stageInfo = detail?.stages.find((s) => s.id === stage) ?? null;
  const blockers = stageInfo?.blockers ?? [];
  // Предусловия обрыва витка считаются отдельно от штатных: у handoff'а два входа, и
  // штатный заблокирован ровно тогда, когда обрыв и нужен.
  const abortBlockers =
    detail?.stages.find((s) => s.id === 'handoff')?.abortBlockers ?? [];

  const build = async (): Promise<void> => {
    setError(null);
    try {
      const r = await api.preparePrompt(runId, stage, requirement === '' ? {} : { requirement });
      setPrompt(r.prompt);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const run = async (
    edited: { system: string; user: string },
    opts: { abortHandoff?: boolean } = {},
  ): Promise<void> => {
    setError(null);
    setBusy(true);
    try {
      await api.runStage(runId, stage, { prompt: edited, ...opts });
    } catch (e) {
      setBusy(false);
      setError((e as Error).message);
    }
  };

  /** Новая попытка того же chunk'а либо следующий chunk — единственный выход из красного вердикта. */
  const advance = async (to: 'attempt' | 'chunk'): Promise<void> => {
    setError(null);
    try {
      await api.advance(runId, to);
      setPrompt(null);
      refresh();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  /**
   * Отмена прогона: доходит до исполнителя, а не просто помечает виток отменённым.
   *
   * `busy` здесь НЕ снимается: `run.cancel()` только выставляет abort, а исполнитель
   * доматывает текущий вызов, и всё это время сервер считает этап выполняющимся. Сняв
   * блокировку по ответу ручки, страница предлагала запустить этап заново и получала 409
   * «этап уже выполняется» — отмена выглядела сломанной. Разблокирует нас `stage_done`
   * или `error`, то есть факт остановки. Артефакты на диске остаются: это остановка, а
   * не откат.
   */
  const cancel = async (): Promise<void> => {
    setError(null);
    try {
      await api.cancel(runId);
      setConfirmCancel(false);
      refresh();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  /**
   * Обрыв витка: этап 7 оформляет передачу без зелёного вердикта.
   *
   * Промпт собирается здесь же, потому что обычная кнопка запуска для handoff'а
   * заблокирована предусловием — оно и требует этого флага.
   */
  const abortWitok = async (): Promise<void> => {
    setError(null);
    setBusy(true);
    try {
      const p = await api.preparePrompt(runId, 'handoff', {});
      await api.runStage(runId, 'handoff', {
        prompt: { system: p.prompt.system, user: p.prompt.user },
        abortHandoff: true,
      });
    } catch (e) {
      setBusy(false);
      setError((e as Error).message);
    }
  };

  const resolveApproval = (requestId: string, decision: Decision): void => {
    void api.resolveApproval(runId, requestId, decision).catch((e: Error) => setError(e.message));
  };

  const decide = async (granted: boolean): Promise<void> => {
    const d = stageInfo?.decision;
    if (d == null || detail === null) return;
    setError(null);
    try {
      await api.recordDecision(runId, {
        artifact: d.artifact,
        label: d.label,
        granted,
        ...(decisionNote.trim() === '' ? {} : { note: decisionNote.trim() }),
        // Chunk и попытка — те, что человек сейчас видит: между чтением артефакта и
        // нажатием кнопки виток мог уйти на следующую попытку.
        chunk: detail.chunk,
        attempt: detail.attempt,
      });
      setDecisionNote('');
      refresh();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const answer = (requestId: string, answers: Record<string, string[]>): void => {
    void api.answerQuestions(runId, requestId, answers).catch((e: Error) => setError(e.message));
  };

  const setAutoRules = (next: AutoApproveRules): void => {
    setAutoRulesByStage((prev) => ({ ...prev, [stage]: next }));
    void api.autoApprove(runId, stage, next).catch((err: Error) => setError(err.message));
  };

  if (detail === null) {
    // Кнопка выхода нужна именно здесь: ветка стала достижимой (виток убрали в соседней
    // вкладке, сервер перезапустился и потерял прогоны из памяти), а без неё со страницы
    // «прогон не найден» не было выхода, кроме перезагрузки браузера.
    return (
      <div className="p-8 text-sm text-neutral-400">
        <div className="mb-3 whitespace-pre-wrap">{error ?? 'Загрузка витка…'}</div>
        <button
          type="button"
          onClick={onExit}
          className="rounded border border-neutral-700 px-3 py-1.5 text-sm hover:bg-neutral-800"
        >
          ← к списку витков
        </button>
      </div>
    );
  }

  // «Ждёт приёмки» — это слот decision И то, что он ещё не записан: decision сам по себе
  // статичен (метаданные этапа), decisionRecorded читает артефакт тем же разбором, что и
  // предусловие следующего этапа.
  const decision =
    stageInfo?.decision != null && !stageInfo.decisionRecorded ? stageInfo.decision : null;

  return (
    <div className="flex h-full flex-col">
      <RunHeader
        detail={detail}
        connected={connected}
        alerts={alerts}
        stageRunning={stageRunning}
        confirmCancel={confirmCancel}
        onConfirmCancel={setConfirmCancel}
        onCancel={() => void cancel()}
        onExit={onExit}
        compact={compact}
        onToggleCompact={toggleCompact}
      />

      <div className="flex min-h-0 flex-1">
        <StageRail run={detail} selected={stage} onSelect={setStage} />

        <main className="min-w-0 flex-1 overflow-auto p-4">
          {error !== null ? (
            <div className={`mb-3 rounded border p-3 text-sm text-red-200 ${PANEL_TONE.fail}`}>
              {error}
            </div>
          ) : null}

          <DecisionQueue
            asks={asks}
            approvals={approvals}
            decision={decision}
            decisionNote={decisionNote}
            onNoteChange={setDecisionNote}
            onDecide={(granted) => void decide(granted)}
            onAnswer={answer}
            onResolve={resolveApproval}
            compact={compact}
          />

          {/* minmax(0,1fr) вместо 1fr: иначе длинные пути в артефактах распирают колонку
              и правая половина уезжает за экран. */}
          <div className="mt-4 grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
            <PromptColumn
              stage={stage}
              prompt={prompt}
              blockers={blockers}
              uiBusy={uiBusy}
              busyReason={busyReason}
              autoRules={autoRules}
              onAutoRulesChange={setAutoRules}
              requirement={requirement}
              onRequirementChange={setRequirement}
              onBuild={() => void build()}
              onRun={(p) => void run(p)}
              compact={compact}
            />

            <section className="min-w-0">
              <h2 className="mb-2 text-sm font-medium">Ход этапа</h2>
              <CollapsibleSection
                id="events"
                title="Лента событий"
                compact={compact}
                defaultOpen={!compact || hasWarning}
                alert={hasWarning}
                summary={
                  <>
                    <span className="text-neutral-500">{stageEventItems.length} строк</span>
                    {hasWarning ? <span className="ml-2 text-amber-400">· есть предупреждение</span> : null}
                  </>
                }
              >
                <div className="max-h-[70vh] overflow-auto bg-neutral-950 p-3">
                  <EventStream events={stageEvents} />
                </div>
              </CollapsibleSection>

              {/* Гейты стоят перед вердиктом и на экране: вердикт считается по этой
                  таблице, и читать их в обратном порядке — читать вывод раньше входа.
                  Условие по этапу то же, что у вердикта: гейты прогоняются на `verify` и
                  под лентой `plan` читались бы как «план провалил сборку». */}
              {stage === 'verify' ? (
                <GatePanel results={gateResults} aborted={detail.gatesAborted} compact={compact} />
              ) : null}

              {/* Патч попытки — там же, где его чинят и где по нему судят. */}
              {stage === 'verify' || stage === 'chunk' ? (
                <RunDiffView runId={runId} compact={compact} />
              ) : null}

              {/* Попытки видны и на chunk, и на verify: чинят на первом, а решают по
                  второму, и история нужна на обоих. */}
              {stage === 'verify' || stage === 'chunk' ? (
                <AttemptsPanel
                  iterations={detail.iterations}
                  attemptBudget={detail.attemptBudget}
                  closenessWarn={detail.progressClosenessWarn}
                  compact={compact}
                />
              ) : null}

              {/* Вердикт не сворачивается ни в одном режиме: это главный вход решения
                  оператора, и прятать его — прятать сам смысл этапа 6. */}
              {detail.verdict !== null && stage === 'verify' ? (
                <VerdictCard
                  verdict={detail.verdict}
                  escalation={detail.escalation}
                  redCause={detail.redCause}
                />
              ) : null}

              {stageInfo !== null ? <StageArtifacts produces={stageInfo.produces} /> : null}
            </section>
          </div>

          {/* Sticky-панель — последним ребёнком прокручиваемого main, вне грида колонок:
              кнопки продвижения и приёмки видны без прокрутки в любом режиме. */}
          <AdvanceBar
            attempt={detail.attempt}
            attemptBudget={detail.attemptBudget}
            uiBusy={uiBusy}
            abortBlockers={abortBlockers}
            decision={decision}
            decisionNote={decisionNote}
            onDecisionNoteChange={setDecisionNote}
            onAdvance={(to) => void advance(to)}
            onAbort={() => void abortWitok()}
            onDecide={(granted) => void decide(granted)}
          />
        </main>
      </div>
    </div>
  );
}
