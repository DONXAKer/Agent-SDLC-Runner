import type { McpServerInfo } from '@sdlc-runner/shared';

import { PANEL_TONE } from '../../lib/tones.ts';
import { CollapsibleSection } from './CollapsibleSection.tsx';

/**
 * Внешние MCP-серверы витка.
 *
 * Отдельная панель нужна ровно из-за одного: недоступный сервер выглядит для модели как
 * «инструмента нет», а чинится он снаружи — запуском редактора или правкой команды. Без
 * этой панели оператор узнавал бы причину только из логов, а хвост stderr дочернего
 * процесса («команда не найдена», «модуль не импортируется») не видел бы вовсе.
 */

const STATE_LABEL: Record<McpServerInfo['state'], string> = {
  connected: 'подключён',
  pending: 'не поднимался',
  unavailable: 'недоступен',
  disabled: 'выключен',
  invalid: 'описание не разобралось',
};

function tone(state: McpServerInfo['state']): string {
  if (state === 'connected') return PANEL_TONE.ok;
  if (state === 'unavailable' || state === 'invalid') return PANEL_TONE.fail;
  return PANEL_TONE.neutral;
}

export function McpPanel({
  servers,
  stage,
  compact,
}: {
  servers: McpServerInfo[];
  /** Набор последнего запущенного этапа и его цена в токенах. */
  stage: { tools: string[]; estimatedTokens: number };
  compact: boolean;
}): JSX.Element | null {
  if (servers.length === 0) return null;

  const broken = servers.some((s) => s.state === 'unavailable' || s.state === 'invalid');

  return (
    <CollapsibleSection
      title="MCP-серверы"
      compact={compact}
      defaultOpen={!compact || broken}
      alert={broken}
    >
      <div className="space-y-2 text-xs">
        {servers.map((s) => (
          <div key={s.name} className={`rounded border p-2 ${tone(s.state)}`}>
            <div className="flex items-baseline justify-between gap-2">
              <span className="font-medium">{s.name}</span>
              <span className="text-neutral-400">
                {STATE_LABEL[s.state]}
                {s.toolCount === null ? '' : ` · инструментов: ${s.toolCount}`}
              </span>
            </div>
            <div className="mt-1 font-mono text-[11px] text-neutral-500">
              {s.transport} · {s.target}
            </div>
            {s.envKeys.length > 0 ? (
              // Только имена ключей: значения — секреты, и в интерфейс они не выходят.
              <div className="mt-1 text-[11px] text-neutral-500">
                подставляется: {s.envKeys.join(', ')}
              </div>
            ) : null}
            {s.reason !== null ? (
              <div className="mt-1 whitespace-pre-wrap text-red-200/80">{s.reason}</div>
            ) : null}
            {s.selected.length > 0 ? (
              <div className="mt-1 text-neutral-300">выдано на этапе: {s.selected.join(', ')}</div>
            ) : null}
            {s.stderrTail !== null ? (
              <pre className="mt-2 max-h-32 overflow-auto rounded bg-neutral-950 p-2 font-mono text-[11px] text-neutral-400">
                {s.stderrTail}
              </pre>
            ) : null}
          </div>
        ))}

        {stage.tools.length > 0 ? (
          <div className="text-neutral-500">
            Набор этапа: {stage.tools.length} инструментов, примерно {stage.estimatedTokens} токенов
            описаний.
          </div>
        ) : null}
      </div>
    </CollapsibleSection>
  );
}
