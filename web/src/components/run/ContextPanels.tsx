import type { RunDetail, StageId } from '@sdlc-runner/shared';

import { AttemptsPanel } from '../AttemptsPanel.tsx';
import { GatePanel } from '../GatePanel.tsx';
import { McpPanel } from './McpPanel.tsx';
import { StageArtifacts } from './StageArtifacts.tsx';

/**
 * Стек контекстных панелей выбранного этапа: гейты, попытки, MCP, артефакты. Живёт
 * вкладкой «Контекст» режима наблюдения — рядом с лентой и диффом, а не колонкой
 * рядом с очередью решений: управление и наблюдение разведены по разным экранам.
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

      {stageInfo !== null ? (
        <StageArtifacts produces={stageInfo.produces} projectRoot={detail.projectRoot} />
      ) : null}
    </>
  );
}
