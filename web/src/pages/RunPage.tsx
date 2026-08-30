import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { EventStream } from '../components/EventStream.tsx';
import { RunDiffView } from '../components/RunDiffView.tsx';
import { StageRail } from '../components/StageRail.tsx';
import { AdvanceBar } from '../components/run/AdvanceBar.tsx';
import { ContextColumn, ContextPanels, DrawerButtons } from '../components/run/ContextColumn.tsx';
import type { DrawerKind } from '../components/run/ContextColumn.tsx';
import { DecisionQueue } from '../components/run/DecisionQueue.tsx';
import { Drawer } from '../components/run/Drawer.tsx';
import { FocusSection } from '../components/run/FocusSection.tsx';
import { LiveProgress } from '../components/run/LiveProgress.tsx';
import { PromptColumn } from '../components/run/PromptColumn.tsx';
import { RunHeader } from '../components/run/RunHeader.tsx';
import { RunMetricsPanel } from '../components/run/RunMetricsPanel.tsx';
import { RunSummaryStrip } from '../components/run/RunSummaryStrip.tsx';
import { VerdictCard } from '../components/run/VerdictCard.tsx';
import { api } from '../lib/api.ts';
import type {
  AutoApproveRules,
  Decision,
  PreparedPrompt,
  RunDetail,
  RunEvent,
  StageId,
} from '@sdlc-runner/shared';
import { AUTO_APPROVE_OFF, describeCall } from '@sdlc-runner/shared';
import { groupEvents } from '../lib/eventGroups.ts';
import { computeNowFocus } from '../lib/nowFocus.ts';
import { decisionQueueCount, mergePending } from '../lib/pending.ts';
import { suggestedStage } from '../lib/stageProgress.ts';
import { BTN_SECONDARY, PANEL_TONE } from '../lib/tones.ts';
import { useOperatorAlerts } from '../lib/useOperatorAlerts.ts';
import { useRunSocket } from '../lib/useRunSocket.ts';

export function RunPage({
  runId,
  initialRequirement = '',
  onExit,
}: {
  runId: string;
  /**
   * Задача витка, набранная на стартовом экране. Только начальное значение: дальше текст
   * живёт здесь и правится на этапе intent — виток, открытый из списка, ничего не
   * подставляет и не затирает.
   */
  initialRequirement?: string;
  onExit: () => void;
}): JSX.Element {
  const [detail, setDetail] = useState<RunDetail | null>(null);
  const [stage, setStage] = useState<StageId>('intent');
  const [prompt, setPrompt] = useState<PreparedPrompt | null>(null);
  const [requirement, setRequirement] = useState(initialRequirement);
  /** Что именно решил человек — сохраняется в артефакте рядом с подписью. */
  const [decisionNote, setDecisionNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Отмена прогона спрашивается вторым кликом: бюджет уже потрачен, отменить отмену нельзя. */
  const [confirmCancel, setConfirmCancel] = useState(false);
  /** Открытая поверх экрана полная поверхность: лента, дифф витка, метрики или контекст. */
  const [drawer, setDrawer] = useState<DrawerKind | null>(null);
  // Этап с диффом — одно вычисление на обе точки кнопок (колонка и узкая панель): пока
  // условие было записано дважды, правка одного места разводила широкий и узкий экраны.
  const diffStage = stage === 'verify' || stage === 'chunk';
  // Панель диффа привязана к этапу так же, как её кнопка: смена этапа закрывает её,
  // иначе она жила бы открытой там, где эта поверхность не предлагается.
  useEffect(() => {
    if (drawer === 'diff' && !diffStage) setDrawer(null);
  }, [drawer, diffStage]);
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
  /**
   * Поправка часов клиент−сервер, снятая В МОМЕНТ ответа. Считать её при рендере от
   * лежалого `detail` нельзя: staleness ответа читалась бы как уход часов, и возраст
   * ожидания замирал бы на времени последнего refresh.
   */
  const clockOffsetMs = useRef(0);
  const refresh = useCallback(() => {
    const gen = ++refreshGen.current;
    api
      .run(runId)
      .then((d) => {
        if (gen === refreshGen.current) {
          clockOffsetMs.current = Date.now() - d.serverNow;
          setDetail(d);
        }
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

  // События ИДУЩЕГО этапа — вход живого прогресса на «Сейчас». Не `stageEvents`: рельс
  // позволяет смотреть один этап, пока выполняется другой, а живой прогресс — про то,
  // что крутится на самом деле.
  const runningStageId = detail?.stage ?? null;
  const runningEvents = useMemo(
    () =>
      runningStageId === null
        ? []
        : events.filter((e) => !('stage' in e) || e.stage === runningStageId || e.stage === null),
    [events, runningStageId],
  );

  // Строк в ленте после схлопывания троек tool_request→resolved→result меньше, чем сырых
  // событий: сводка «N событий» обязана называть то же число, что видно после разворота.
  const stageEventItems = useMemo(() => groupEvents(stageEvents), [stageEvents]);
  // warning не должен тонуть в закрытой ленте: его текст выталкивается на экран янтарной
  // полосой в центре (см. рендер), а не только меткой ⚠ на кнопке — раньше это делала
  // авторазворачивающаяся секция ленты, и потерять сигнал значит идти этапом без сервера,
  // о недоступности которого прогон честно предупредил.
  const warnings = useMemo(
    () => stageEvents.filter((e): e is Extract<RunEvent, { type: 'warning' }> => e.type === 'warning'),
    [stageEvents],
  );
  const hasWarning = warnings.length > 0;

  // Красный вердикт — тоже «виток стоит и ждёт человека», хотя это не decision-слот и не
  // запрос от агента; без него ни счётчик в заголовке вкладки, ни уведомление о красном
  // вердикте не срабатывали вовсе.
  const verdictNeedsAction = detail !== null && detail.verdict !== null && !detail.verdict.passed;

  /** Всё, что стоит и ждёт человека прямо сейчас, — вход для оповещений и счётчика. */
  const waiting = useMemo(
    () => [
      ...(verdictNeedsAction
        ? [{ id: 'verdict-red', text: 'красный вердикт — виток стоит и ждёт решения' }]
        : []),
      ...asks.map((a) => ({
        id: a.requestId,
        text: a.questions[0]?.question ?? 'вопрос от агента',
      })),
      ...approvals.map((p) => ({ id: p.requestId, text: describeCall(p.call) })),
    ],
    [asks, approvals, verdictNeedsAction],
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
   * Открытый виток встаёт туда, где он реально находится, а не на `intent` — правило
   * выбора живёт в `suggestedStage`. Флаг ставится только после фактического выбора,
   * иначе этап, стартовавший через секунду после монтирования, тоже терялся.
   */
  const stageSeeded = useRef(false);
  useEffect(() => {
    if (stageSeeded.current || detail === null) return;
    const seed = suggestedStage(
      detail.stage,
      detail.stages,
      detail.verdict !== null && !detail.verdict.passed,
    );
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

  /**
   * В useCallback — иначе keydown-эффект очереди решений пересоздаёт подписку на каждый
   * рендер страницы, то есть на каждое событие ленты.
   *
   * Повторное решение по уже закрытому запросу — двойной клик, вторая вкладка, шорткат
   * до обновления очереди — штатный исход, а не ошибка: сервер отвечает «запрос уже
   * разрешён или устарел», и красный баннер здесь сообщал бы об успехе тоном поломки.
   * Достаточно перечитать состояние.
   */
  const resolveApproval = useCallback(
    (requestId: string, decision: Decision): void => {
      void api.resolveApproval(runId, requestId, decision).catch((e: Error) => {
        if (e.message.includes('уже разрешён')) {
          refresh();
          return;
        }
        setError(e.message);
      });
    },
    [runId, refresh],
  );

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

  // Что на «Сейчас» главное — считает чистая машина фокуса; здесь только рендер по ней.
  const focus = computeNowFocus({
    queueCount: decisionQueueCount(asks, approvals, decision),
    runningStage: detail.stage,
    verdictRed: verdictNeedsAction,
    nextRunnable: suggestedStage(null, detail.stages, verdictNeedsAction),
  });
  const stageTitle = (id: StageId): string =>
    detail.stages.find((s) => s.id === id)?.title ?? id;

  // Панель закрывает очередь целиком и съедает её видимость — второй сигнал ждущих
  // решений лежит поверх неё. Спред-объект вместо `banner={undefined}` — требование
  // exactOptionalPropertyTypes.
  const nowCount = decisionQueueCount(asks, approvals, decision) + (verdictNeedsAction ? 1 : 0);
  const drawerBanner =
    nowCount === 0
      ? {}
      : {
          banner: (
            <button
              type="button"
              onClick={() => setDrawer(null)}
              className="flex w-full items-center gap-2 border-b border-amber-900/60 bg-amber-950/30 px-4 py-2 text-left text-xs text-amber-300 hover:bg-amber-950/50"
            >
              <span className="rounded bg-amber-900/60 px-1.5 py-0.5 text-amber-200">{nowCount}</span>
              Ждут решения — закрыть панель
            </button>
          ),
        };

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
      />
      <RunSummaryStrip detail={detail} />

      <div className="flex min-h-0 flex-1">
        <StageRail run={detail} selected={stage} onSelect={setStage} />

        <main className="min-w-0 flex-1 overflow-auto p-4">
          {error !== null ? (
            <div className={`mb-3 rounded border p-3 text-sm text-red-200 ${PANEL_TONE.fail}`}>
              {error}
            </div>
          ) : null}

          {/* Узкий экран: правая колонка контекста скрыта, её содержимое и полные
              поверхности открываются отсюда — панель «Контекст» держит гейты и MCP
              достижимыми на любой ширине. */}
          <div className="mb-3 flex gap-2 lg:hidden">
            <DrawerButtons
              eventRows={stageEventItems.length}
              hasWarning={hasWarning}
              diffStage={diffStage}
              onOpen={setDrawer}
            />
            <button
              type="button"
              onClick={() => setDrawer('context')}
              className={`${BTN_SECONDARY} flex-1 px-2 py-1.5 text-xs`}
            >
              Контекст
            </button>
          </div>

          <div className="space-y-4">
            {/* Текст предупреждений — на экране, а не за кликом: см. комментарий у
                `warnings` выше. Показываются последние, самые свежие. */}
            {hasWarning ? (
              <div className={`rounded border p-3 text-xs text-amber-200 ${PANEL_TONE.warn}`}>
                {warnings.slice(-3).map((w, i) => (
                  <div key={i}>⚠ {w.message}</div>
                ))}
              </div>
            ) : null}

            {/* Очередь решений не заворачивается в FocusSection никогда: «молчание
                одобрением не считается» держится на видимости карточек. Пустая очередь
                рендерит null сама. */}
            <DecisionQueue
              asks={asks}
              approvals={approvals}
              decision={decision}
              decisionNote={decisionNote}
              clockOffsetMs={clockOffsetMs.current}
              suspended={drawer !== null}
              onNoteChange={setDecisionNote}
              onDecide={(granted) => void decide(granted)}
              onAnswer={answer}
              onResolve={resolveApproval}
            />

            {/* Вердикт в центре и не сворачивается: красный — потому что виток стоит и
                причина обязана быть рядом с кнопками продвижения (по verdictNeedsAction
                напрямую, а не по focus.kind: порядок веток машины фокуса не должен молча
                прятать карточку); на verify — потому что это главный вход решения
                оператора, и прятать его — прятать смысл этапа 6. */}
            {detail.verdict !== null && (verdictNeedsAction || stage === 'verify') ? (
              <VerdictCard
                verdict={detail.verdict}
                escalation={detail.escalation}
                redCause={detail.redCause}
              />
            ) : null}

            {detail.stage !== null ? (
              <FocusSection
                title={`Выполняется: ${stageTitle(detail.stage)}`}
                focused={focus.kind === 'running'}
                summary={<span className="text-amber-400">этап идёт</span>}
              >
                <LiveProgress events={runningEvents} currency={detail?.currency} onOpenFull={() => setDrawer('events')} />
              </FocusSection>
            ) : null}

            <FocusSection
              title={`Запрос к модели — ${stageTitle(stage)}`}
              focused={focus.kind === 'prepare' || focus.kind === 'finished'}
              summary={
                blockers.length > 0
                  ? `этап заблокирован (${blockers.length})`
                  : prompt === null
                    ? 'промпт не собран'
                    : 'промпт собран'
              }
            >
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
              />
            </FocusSection>

            <AdvanceBar
              attempt={detail.attempt}
              attemptBudget={detail.attemptBudget}
              uiBusy={uiBusy}
              abortBlockers={abortBlockers}
              prominent={focus.kind === 'verdict-red'}
              onAdvance={(to) => void advance(to)}
              onAbort={() => void abortWitok()}
            />
          </div>
        </main>

        <ContextColumn
          detail={detail}
          stage={stage}
          diffStage={diffStage}
          eventRows={stageEventItems.length}
          hasWarning={hasWarning}
          onOpenDrawer={setDrawer}
        />
      </div>

      {drawer === 'events' ? (
        <Drawer title="Лента событий" onClose={() => setDrawer(null)} {...drawerBanner}>
          <EventStream events={stageEvents} precomputed={stageEventItems} currency={detail?.currency} />
        </Drawer>
      ) : null}
      {/* Патч попытки доступен с обоих diff-этапов: чинят по нему на chunk, судят на
          verify — история нужна на обоих. */}
      {drawer === 'diff' ? (
        <Drawer title="Diff витка" onClose={() => setDrawer(null)} {...drawerBanner}>
          <RunDiffView runId={runId} compact={false} />
        </Drawer>
      ) : null}
      {drawer === 'metrics' ? (
        <Drawer title="Метрики витка" onClose={() => setDrawer(null)} {...drawerBanner}>
          <RunMetricsPanel detail={detail} />
        </Drawer>
      ) : null}
      {drawer === 'context' ? (
        <Drawer title="Контекст этапа" onClose={() => setDrawer(null)} {...drawerBanner}>
          <div className="space-y-3">
            <ContextPanels detail={detail} stage={stage} diffStage={diffStage} />
          </div>
        </Drawer>
      ) : null}
    </div>
  );
}
