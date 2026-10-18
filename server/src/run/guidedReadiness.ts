import type { PreparedPrompt, StageDecisionCheck, StageId } from '@sdlc-runner/shared';
import { progressHash } from './guidedProgress.ts';

/** Called after the existing stage requires/initialization checks. This permits
 * an attempt, not acceptance: executor, write policy and result gates still run. */
export function guidedRuntimeReadiness(stage: StageId, prompt: PreparedPrompt): StageDecisionCheck {
  let problem: string | null = null;
  try {
    const input = JSON.parse(prompt.user);
    if (!prompt.guidedProtocol || !Array.isArray(input.data?.requests) ||
        !input.data.requests.length || input.data.requests.some((request: unknown) => typeof request !== 'string' || !request.trim())) {
      problem = 'Нет исходного запроса для исполнения этапа';
    }
  } catch { problem = 'Повреждены структурированные входные данные этапа'; }
  return { stage, at: new Date().toISOString(), inputRevision: progressHash(prompt.user),
    decision: problem ?? 'Предусловия этапа проверены рантаймом; можно предложить следующий результат',
    evidence: [], uncertainties: problem ? [problem] : [], action: problem ? 'blocked' : 'proceed',
    reason: problem ?? 'Смысл ответа будет проверен после предложения; предварительное самоподтверждение модели не требуется',
    status: problem ? 'blocked' : 'ready', changed: false, checkedBy: 'runtime' };
}
