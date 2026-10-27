import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ComponentProps } from 'react';

import type { DashboardCard, DashboardCardRef, DashboardDetail, DashboardResponse, StageId } from '@sdlc-runner/shared';

import { DashboardFilters } from '../components/dashboard/DashboardFilters.tsx';
import { FlowTimeline } from '../components/dashboard/FlowTimeline.tsx';
import { NowRunning } from '../components/dashboard/NowRunning.tsx';
import { RunDetailDialog } from '../components/dashboard/RunDetailDialog.tsx';
import { Modal } from '../components/Modal.tsx';
import { NewRunWizard } from '../components/start/NewRunWizard.tsx';
import { api } from '../lib/api.ts';
import { applyFilter, parseFilter, projectOptions, serializeFilter } from '../lib/dashboardFilter.ts';
import type { DashboardFilter } from '../lib/dashboardFilter.ts';
import { cardKey, reuseCards, sameCard, sortCards } from '../lib/dashboardSort.ts';
import { detailFreshnessKey } from '../lib/dashboardStages.ts';
import { flowCounts } from '../lib/flowTimeline.ts';
import { readLS, writeLS } from '../lib/persist.ts';
import { BTN_SECONDARY } from '../lib/tones.ts';
import { useVisiblePoll } from '../lib/useVisiblePoll.ts';

/** Период опроса списка, мс — как у списка открытых витков. */
const POLL_MS = 5_000;
/** Шаг «сейчас»: мельче минуты — чтобы порог «нет движения» не запаздывал на минуту. */
const NOW_STEP_MS = 15_000;
/** Карточек за раз: сотни прогонов стенда разом — это тысячи узлов на каждый тик. */
const PAGE = 60;
const FILTER_KEY = 'dashboardFilter';

type NewRunProps = Omit<ComponentProps<typeof NewRunWizard>, 'onStart' | 'onCancel'>;

/** Единый экран создания и наблюдения за всеми запусками. */
export function DashboardPage({
  card: openRef,
  stageTitles,
  error: appError,
  newRun,
  onStart,
  onOpenCard,
  onCloseCard,
  onOpenLive,
  onOpenArchive,
}: {
  card: DashboardCardRef | null;
  stageTitles: Partial<Record<StageId, string>>;
  error: string | null;
  newRun: NewRunProps | null;
  onStart: () => Promise<boolean>;
  onOpenCard: (ref: DashboardCardRef) => void;
  onCloseCard: () => void;
  onOpenLive: (runId: string) => void;
  onOpenArchive: (project: string, slug: string) => void;
}): JSX.Element {
  const [list, setList] = useState<DashboardResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [wizard, setWizard] = useState(false);
  const [starting, setStarting] = useState(false);
  // «Сейчас» — по часам СЕРВЕРА и с шагом `NOW_STEP_MS`: подписи «N мин назад» и «нет
  // движения» сравнивают с `updatedAt` сервера, а сервер в docker или на другой машине живёт
  // по своим часам. Шаг — чтобы тик опроса без изменений не перерисовывал все карточки ради
  // нового числа, которое подписи всё равно не покажут. `skewKnown` — поправка уже получена
  // (из заголовка списка либо из детали, открытой по прямой ссылке раньше списка).
  const skew = useRef(0);
  const skewKnown = useRef(false);
  const stepNow = (): number => Math.floor((Date.now() + skew.current) / NOW_STEP_MS) * NOW_STEP_MS;
  const setSkew = (serverNow: number): void => {
    skew.current = serverNow - Date.now();
    skewKnown.current = true;
  };
  const [nowMs, setNowMs] = useState(stepNow);
  const [filter, setFilter] = useState<DashboardFilter>(() => parseFilter(readLS(FILTER_KEY)));
  const [limit, setLimit] = useState(PAGE);
  const etag = useRef<string | null>(null);

  useEffect(() => writeLS(FILTER_KEY, serializeFilter(filter)), [filter]);
  // Новый фильтр — снова с первой страницы.
  useEffect(() => setLimit(PAGE), [filter]);

  // Поколение запроса списка: ответ, пришедший позже более свежего (ручное «обновить»
  // обогнало фоновый тик), не откатывает ни список, ни метку, ни ошибку.
  const listGen = useRef(0);
  const load = useCallback((manual: boolean): void => {
    // Ошибку гасит только действие человека: фоновый тик стирал бы причину отказа через
    // пять секунд после её появления (тот же урок, что у списка открытых витков).
    if (manual) setError(null);
    const my = ++listGen.current;
    api
      .dashboard(manual ? null : etag.current)
      .then(({ etag: tag, serverNow, data }) => {
        if (my !== listGen.current) return;
        etag.current = tag;
        // Часы — из заголовка (он свежий и на 304); тело — запасной путь для старого сервера.
        if (serverNow !== null) setSkew(serverNow);
        else if (data !== null) setSkew(data.serverNow);
        if (data !== null) setList((prev) => ({ ...data, cards: reuseCards(prev?.cards ?? null, data.cards) }));
        setNowMs(stepNow());
      })
      .catch((e: Error) => {
        if (my === listGen.current) setError(e.message);
      });
    // `stepNow`/`setSkew` читают и пишут только ref — зависимостей у колбэка нет.
  }, []);

  useEffect(() => load(true), [load]);
  const autoRefresh = useCallback(() => load(false), [load]);
  useVisiblePoll(autoRefresh, POLL_MS);

  const cards = useMemo(() => (list === null ? [] : sortCards(list.cards)), [list]);
  const filtered = useMemo(() => applyFilter(cards, filter, nowMs), [cards, filter, nowMs]);
  const projects = useMemo(() => projectOptions(cards), [cards]);

  // ── детали ──────────────────────────────────────────────────────────────
  const [detail, setDetail] = useState<DashboardDetail | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const gen = useRef(0);
  const openKey = openRef === null ? null : cardKey(openRef);
  // Без учёта смены источника terminal → ui: адрес открытой детали при этом прежний.
  const listed = openRef === null ? undefined : cards.find((c) => sameCard(c.ref, openRef));
  // Ключ свежести: деталь перезапрашивается, когда карточка в списке изменилась, — без
  // своего опроса и без мигания экрана (старая деталь остаётся до прихода новой).
  const fresh = listed === undefined ? null : detailFreshnessKey(listed);

  const fetchDetail = useCallback((ref: DashboardCardRef, reset: boolean): void => {
    const my = ++gen.current;
    if (reset) {
      setDetail(null);
      setDetailError(null);
    }
    api
      .dashboardDetail(ref)
      .then((d) => {
        // Просевший ответ прошлой карточки не перетирает ответ текущей.
        if (my !== gen.current) return;
        // Деталь по прямой ссылке может прийти раньше списка — поправка часов тогда из неё.
        if (!skewKnown.current) {
          setSkew(d.serverNow);
          setNowMs(stepNow());
        }
        setDetail(d);
      })
      .catch((e: Error) => {
        if (my === gen.current) setDetailError(e.message);
      });
  }, []);

  // Ключ свежести, при котором деталь последний раз запрашивалась.
  const fetchedFresh = useRef<string | null>(null);

  useEffect(() => {
    fetchedFresh.current = null;
    if (openRef === null) {
      gen.current++;
      setDetail(null);
      return;
    }
    fetchDetail(openRef, true);
    // Адрес сравнивается ключом (`openKey`): объект пересоздаётся на каждый разбор hash'а.
  }, [openKey, fetchDetail]);

  useEffect(() => {
    if (openRef === null || fresh === null) return;
    // Первое значение после открытия — то, с которым деталь уже запрошена выше.
    if (fetchedFresh.current === null) {
      fetchedFresh.current = fresh;
      return;
    }
    if (fetchedFresh.current === fresh) return;
    fetchedFresh.current = fresh;
    fetchDetail(openRef, false);
  }, [fresh, openRef, fetchDetail]);

  const openCard = useCallback((c: DashboardCard) => onOpenCard(c.ref), [onOpenCard]);
  const startNew = async (): Promise<void> => {
    if (starting) return;
    setStarting(true);
    try {
      if (await onStart()) setWizard(false);
    } finally {
      setStarting(false);
    }
  };

  const shown = filtered.slice(0, limit);
  const counts = flowCounts(cards);
  return (
    <div className="mx-auto max-w-6xl p-6">
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div>
          <h1 className="text-xl font-medium">Флоу запусков</h1>
          <p className="mt-1 text-xs text-neutral-500">Все SDLC-витки и прогоны стенда в одной вертикальной ленте</p>
        </div>
        <div className="ml-auto flex gap-2">
          <button type="button" onClick={() => load(true)} className={`${BTN_SECONDARY} px-3 py-1.5 text-xs`}>Обновить</button>
          <button type="button" onClick={() => setWizard(true)} disabled={newRun === null} className="rounded bg-emerald-700 px-3 py-1.5 text-xs font-medium hover:bg-emerald-600 disabled:bg-neutral-800 disabled:text-neutral-500">+ Новый виток</button>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <div className="rounded border border-neutral-800 px-3 py-2 text-xs text-neutral-400">Всего <span className="ml-1 text-lg text-neutral-100">{counts.total}</span></div>
        <div className="rounded border border-emerald-900 px-3 py-2 text-xs text-emerald-300">Работает <span className="ml-1 text-lg">{counts.running}</span></div>
        <div className="rounded border border-amber-900 px-3 py-2 text-xs text-amber-300">Ждёт человека <span className="ml-1 text-lg">{counts.waiting}</span></div>
        <div className="rounded border border-red-900 px-3 py-2 text-xs text-red-300">С ошибкой <span className="ml-1 text-lg">{counts.failed}</span></div>
      </div>

      {list !== null ? <NowRunning cards={cards} titles={stageTitles} nowMs={nowMs} onOpen={openCard} /> : null}
      {appError !== null ? <div className="mt-3 whitespace-pre-wrap rounded border border-red-900 bg-red-950/30 px-3 py-2 text-sm text-red-300">{appError}</div> : null}
      {error !== null ? <div className="mt-3 rounded border border-red-900 bg-red-950/30 px-3 py-2 text-sm text-red-300">{error}</div> : null}

      <div className="mt-4"><DashboardFilters filter={filter} projects={projects} shown={filtered.length} total={cards.length} onChange={setFilter} /></div>
      {list !== null && !list.bench.available ? <div className="mt-2 text-xs text-neutral-500">каталога стенда на этой машине нет — прогоны bench не показываются</div> : null}
      {list !== null && list.bench.skipped > 0 ? <div className="mt-2 text-xs text-amber-400">файлов результата стенда не разобрано: {list.bench.skipped}</div> : null}

      {list === null ? (
        <div className="mt-6 text-sm text-neutral-500">{error === null ? 'Загрузка…' : ''}</div>
      ) : filtered.length === 0 ? (
        <div className="mt-6 rounded border border-dashed border-neutral-800 p-6 text-sm text-neutral-500">
          {cards.length === 0 ? 'Запусков пока нет. Нажмите «Новый виток», чтобы создать первый.' : 'Под фильтр не попало ни одного запуска.'}
        </div>
      ) : (
        <>
          <FlowTimeline cards={shown} titles={stageTitles} nowMs={nowMs} onOpen={openCard} />
          {filtered.length > shown.length ? <div className="mt-4 text-center"><button type="button" onClick={() => setLimit((value) => value + PAGE)} className={`${BTN_SECONDARY} px-3 py-1 text-xs`}>показать ещё {Math.min(PAGE, filtered.length - shown.length)} из {filtered.length - shown.length}</button></div> : null}
        </>
      )}

      {wizard && newRun !== null ? (
        <Modal title="Новый SDLC-виток" onClose={() => setWizard(false)} className="max-w-4xl">
          <div className="p-4">
            {appError !== null ? <div className="mb-3 whitespace-pre-wrap rounded border border-red-900 bg-red-950/30 px-3 py-2 text-sm text-red-300">{appError}</div> : null}
            <NewRunWizard {...newRun} starting={starting} onStart={() => void startNew()} onCancel={() => setWizard(false)} />
          </div>
        </Modal>
      ) : null}

      {openRef !== null ? detail === null ? (
        <Modal title={`${openRef.project} · ${openRef.slug}`} onClose={onCloseCard}>
          <div className={`p-6 text-sm ${detailError === null ? 'text-neutral-500' : 'text-red-300'}`}>{detailError ?? 'Загрузка запуска…'}</div>
        </Modal>
      ) : (
        <RunDetailDialog key={openKey ?? ''} detail={detail} titles={stageTitles} nowMs={nowMs} gone={list !== null && listed === undefined} onClose={onCloseCard} onOpenLive={onOpenLive} onOpenArchive={onOpenArchive} />
      ) : null}
    </div>
  );
}
