import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { DashboardCard, DashboardCardRef, DashboardDetail, DashboardResponse, StageId } from '@sdlc-runner/shared';

import { BoardView } from '../components/dashboard/BoardView.tsx';
import { DashboardFilters } from '../components/dashboard/DashboardFilters.tsx';
import { NowRunning } from '../components/dashboard/NowRunning.tsx';
import { RunCard } from '../components/dashboard/RunCard.tsx';
import { RunDetailPanel } from '../components/dashboard/RunDetailPanel.tsx';
import { api } from '../lib/api.ts';
import { parseView } from '../lib/dashboardBoard.ts';
import type { DashboardView } from '../lib/dashboardBoard.ts';
import { applyFilter, parseFilter, projectOptions, serializeFilter } from '../lib/dashboardFilter.ts';
import type { DashboardFilter } from '../lib/dashboardFilter.ts';
import { cardKey, reuseCards, sameCard, sortCards } from '../lib/dashboardSort.ts';
import { detailFreshnessKey } from '../lib/dashboardStages.ts';
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
const VIEW_KEY = 'dashboardView';

/**
 * Дашборд запусков: витки всех проектов (из интерфейса и из терминальных скиллов) и
 * прогоны стенда — карточками со статусом по этапам и по файлам витка. Только чтение:
 * управлять живым витком — на его странице.
 */
export function DashboardPage({
  card: openRef,
  stageTitles,
  onOpenCard,
  onCloseCard,
  onOpenLive,
  onOpenArchive,
  onExit,
}: {
  card: DashboardCardRef | null;
  stageTitles: Partial<Record<StageId, string>>;
  onOpenCard: (ref: DashboardCardRef) => void;
  onCloseCard: () => void;
  onOpenLive: (runId: string) => void;
  onOpenArchive: (project: string, slug: string) => void;
  onExit: () => void;
}): JSX.Element {
  const [list, setList] = useState<DashboardResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
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
  const [view, setView] = useState<DashboardView>(() => parseView(readLS(VIEW_KEY)));
  useEffect(() => writeLS(VIEW_KEY, view), [view]);
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
  const filtered = useMemo(() => applyFilter(cards, filter), [cards, filter]);
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

  if (openRef !== null) {
    if (detail === null) {
      return (
        <div className="mx-auto max-w-4xl p-8 text-sm">
          <button type="button" onClick={onCloseCard} className="mb-4 text-neutral-400 hover:text-neutral-200">
            ← к карточкам
          </button>
          <div className={detailError === null ? 'text-neutral-500' : 'text-red-300'}>{detailError ?? 'Загрузка карточки…'}</div>
        </div>
      );
    }
    return (
      <RunDetailPanel
        key={openKey ?? ''}
        detail={detail}
        titles={stageTitles}
        nowMs={nowMs}
        gone={list !== null && listed === undefined}
        onBack={onCloseCard}
        onOpenLive={onOpenLive}
        onOpenArchive={onOpenArchive}
      />
    );
  }

  const shown = filtered.slice(0, limit);
  return (
    <div className={`mx-auto p-6 ${view === 'board' ? 'max-w-none' : 'max-w-7xl'}`}>
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <button type="button" onClick={onExit} className="text-sm text-neutral-400 hover:text-neutral-200">
          ← на старт
        </button>
        <h1 className="text-xl font-medium">Запуски</h1>
        <span className="text-xs text-neutral-500">витки из интерфейса и терминала, прогоны стенда</span>
        <div className="ml-auto flex overflow-hidden rounded border border-neutral-700 text-xs">
          {(['board', 'grid'] as const).map((v) => (
            <button
              key={v}
              type="button"
              onClick={() => setView(v)}
              className={`px-2 py-0.5 ${view === v ? 'bg-neutral-800 text-neutral-100' : 'text-neutral-400 hover:bg-neutral-900'}`}
            >
              {v === 'board' ? 'доска по этапам' : 'карточки'}
            </button>
          ))}
        </div>
        <button type="button" onClick={() => load(true)} className={`${BTN_SECONDARY} px-2 py-0.5 text-xs`}>
          обновить
        </button>
      </div>

      {list !== null ? <NowRunning cards={cards} titles={stageTitles} nowMs={nowMs} onOpen={openCard} /> : null}

      {error !== null ? (
        <div className="mb-3 rounded border border-red-900 bg-red-950/30 px-3 py-2 text-sm text-red-300">{error}</div>
      ) : null}

      <DashboardFilters filter={filter} projects={projects} shown={filtered.length} total={cards.length} onChange={setFilter} />
      {list !== null && !list.bench.available ? (
        <div className="mt-2 text-xs text-neutral-500">каталога стенда на этой машине нет — прогоны bench не показываются</div>
      ) : null}
      {list !== null && list.bench.skipped > 0 ? (
        <div className="mt-2 text-xs text-amber-400">файлов результата стенда не разобрано: {list.bench.skipped}</div>
      ) : null}

      {list === null ? (
        <div className="mt-6 text-sm text-neutral-500">{error === null ? 'Загрузка…' : ''}</div>
      ) : filtered.length === 0 ? (
        <div className="mt-6 text-sm text-neutral-500">
          {cards.length === 0 ? 'Запусков пока нет: ни витков в .sdlc/ проектов конфига, ни результатов стенда.' : 'Под фильтр не попало ни одной карточки.'}
        </div>
      ) : view === 'board' ? (
        <BoardView cards={filtered} titles={stageTitles} nowMs={nowMs} onOpen={openCard} />
      ) : (
        <>
          <div className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
            {shown.map((c) => (
              <RunCard
                key={cardKey(c.ref)}
                card={c}
                titles={stageTitles}
                nowMs={nowMs}
                onOpen={openCard}
                onOpenLive={onOpenLive}
                onOpenArchive={onOpenArchive}
              />
            ))}
          </div>
          {filtered.length > shown.length ? (
            <div className="mt-4 text-center">
              <button type="button" onClick={() => setLimit((l) => l + PAGE)} className={`${BTN_SECONDARY} px-3 py-1 text-xs`}>
                показать ещё {Math.min(PAGE, filtered.length - shown.length)} из {filtered.length - shown.length}
              </button>
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}
