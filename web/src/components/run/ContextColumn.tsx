import type { RunDetail, StageId } from '@sdlc-runner/shared';

import { BTN_SECONDARY } from '../../lib/tones.ts';
import { AttemptsPanel } from '../AttemptsPanel.tsx';
import { GatePanel } from '../GatePanel.tsx';
import { McpPanel } from './McpPanel.tsx';
import { StageArtifacts } from './StageArtifacts.tsx';

export type DrawerKind = 'events' | 'diff' | 'metrics' | 'context';

/**
 * Стек контекстных панелей выбранного этапа. Отдельно от колонки, потому что поверхностей
 * две: колонка на широком экране и панель «Контекст» на узком — гейты и MCP обязаны быть
 * достижимы на любой ширине, а не только там, где помещается колонка.
 */
export function ContextPanels({
  detail,
  stage,
  diffStage,
}: {
  detail: RunDetail;
  stage: StageId;
  /** Этап с диффом (chunk|verify) — считается в RunPage один раз на обе поверхности. */
  diffStage: boolean;
}): JSX.Element {
  const stageInfo = detail.stages.find((s) => s.id === stage) ?? null;

  return (
    <>
      {/* Гейты — только на verify: под лентой плана «план провалил сборку» читался бы
          как факт. И НЕ compact: вердикт считается по этой таблице, и человек обязан
          видеть её таблицей до вердикта — читать вывод раньше входа нельзя, а строка
          «✅ 5» таблицей не является. Итоги — только из ответа сервера, не из ленты
          событий: `gate_result` копится за все попытки витка, а рантайм на новой попытке
          свои итоги честно обнуляет (`resetAttemptState`) — клиент, реконструирующий
          таблицу из ленты, показывал бы зелёные гейты попытки, которая ещё не
          запускалась. Этот дефект на сервере уже чинили. */}
      {stage === 'verify' ? (
        <GatePanel results={detail.gateResults} aborted={detail.gatesAborted} compact={false} />
      ) : null}

      {/* Попытки видны и на chunk, и на verify: чинят на первом, а решают по второму,
          и история нужна на обоих. */}
      {diffStage ? (
        <AttemptsPanel
          iterations={detail.iterations}
          attemptBudget={detail.attemptBudget}
          closenessWarn={detail.progressClosenessWarn}
          compact
        />
      ) : null}

      {/* Серверы MCP — рядом с гейтами, а не отдельной поверхностью: это наблюдение за
          прогоном, и недоступный сервер надо видеть там же, где упавший гейт. */}
      <McpPanel servers={detail.mcpServers} stage={detail.mcpStage} compact />

      {stageInfo !== null ? <StageArtifacts produces={stageInfo.produces} /> : null}
    </>
  );
}

/**
 * Трио кнопок полных поверхностей. Один компонент на обе точки рендера (подвал колонки и
 * узкая панель RunPage) — пока блок был скопирован, правка одной поверхности молча
 * разъезжалась со второй.
 */
export function DrawerButtons({
  eventRows,
  hasWarning,
  diffStage,
  onOpen,
}: {
  /** Сколько строк покажет лента после схлопывания троек — для подписи кнопки. */
  eventRows: number;
  hasWarning: boolean;
  diffStage: boolean;
  onOpen: (kind: DrawerKind) => void;
}): JSX.Element {
  return (
    <>
      <button
        type="button"
        onClick={() => onOpen('events')}
        className={`${BTN_SECONDARY} flex-1 px-2 py-1.5 text-xs`}
      >
        Лента · {eventRows}
        {hasWarning ? <span className="ml-1 text-amber-400">⚠</span> : null}
      </button>
      {diffStage ? (
        <button
          type="button"
          onClick={() => onOpen('diff')}
          className={`${BTN_SECONDARY} flex-1 px-2 py-1.5 text-xs`}
        >
          Diff витка
        </button>
      ) : null}
      <button
        type="button"
        onClick={() => onOpen('metrics')}
        className={`${BTN_SECONDARY} flex-1 px-2 py-1.5 text-xs`}
      >
        Метрики
      </button>
    </>
  );
}

/**
 * Правая колонка контекста: гейты, попытки, MCP и артефакты выбранного этапа — всегда
 * на виду рядом с очередью решений, а не на соседней вкладке. Полные поверхности
 * (лента, дифф витка, метрики) открываются из подвала колонки поверх экрана.
 */
export function ContextColumn({
  detail,
  stage,
  diffStage,
  eventRows,
  hasWarning,
  onOpenDrawer,
}: {
  detail: RunDetail;
  stage: StageId;
  diffStage: boolean;
  eventRows: number;
  hasWarning: boolean;
  onOpenDrawer: (kind: DrawerKind) => void;
}): JSX.Element {
  return (
    // Ниже lg колонка скрыта: центр с очередью решений важнее, а те же панели открываются
    // с узкой строки кнопок RunPage — панелью «Контекст», не только лентой/диффом.
    <aside className="hidden w-96 shrink-0 flex-col border-l border-neutral-800 lg:flex">
      <div className="min-h-0 flex-1 space-y-3 overflow-auto p-3">
        <ContextPanels detail={detail} stage={stage} diffStage={diffStage} />
      </div>
      <div className="flex gap-2 border-t border-neutral-800 p-3">
        <DrawerButtons
          eventRows={eventRows}
          hasWarning={hasWarning}
          diffStage={diffStage}
          onOpen={onOpenDrawer}
        />
      </div>
    </aside>
  );
}
