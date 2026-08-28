import type {
  DiffPreview,
  NormalizedCall,
  PolicyVerdict,
  Question,
  RunDetail,
  RunEvent,
} from '@sdlc-runner/shared';

export interface PendingCall {
  requestId: string;
  /**
   * Аргументы инструмента в его собственной форме — то, что правит оператор.
   *
   * Не `call`: исполнителю уходит `updatedInput` дословно, в форме инструмента
   * (`file_path`, `old_string`), а нормализованная форма (`path`, `oldStr`) на входе
   * инструмента не значит ничего — правка молча теряла содержимое.
   */
  rawInput: Record<string, unknown>;
  call: NormalizedCall;
  policy: PolicyVerdict;
  preview: DiffPreview | null;
  /** Предупреждение о перезаписи с потерей содержимого. `null` — потери нет. */
  destructive: string | null;
}

export interface PendingAsk {
  requestId: string;
  questions: Question[];
}

/**
 * Что ещё ждёт ответа.
 *
 * Источник — ответ сервера (`detail.pendingApprovals` / `pendingQuestions`), а лента
 * событий только дополняет его свежими запросами, о которых сервер ещё не спрашивали.
 * Пока очередь выводилась ИСКЛЮЧИТЕЛЬНО из ленты, она теряла запросы: буфер шины
 * ограничен объёмом и вытесняет с начала, а при переподключении сокета лента
 * сбрасывается — карточка одобрения исчезала, промис на сервере не резолвился ничем,
 * и этап вставал навсегда, хотя `GET /api/runs/:id` этот запрос честно перечислял.
 */
export function mergePending(
  detail: RunDetail | null,
  events: RunEvent[],
): { approvals: PendingCall[]; asks: PendingAsk[] } {
  const resolved = new Set<string>();
  const answered = new Set<string>();
  for (const e of events) {
    if (e.type === 'tool_resolved') resolved.add(e.requestId);
    if (e.type === 'tool_result') answered.add(e.requestId);
  }

  const approvals = new Map<string, PendingCall>();
  const asks = new Map<string, PendingAsk>();

  for (const p of detail?.pendingApprovals ?? []) {
    approvals.set(p.requestId, {
      requestId: p.requestId,
      rawInput: p.rawInput,
      call: p.call,
      policy: p.policy,
      preview: p.preview,
      destructive: p.destructive,
    });
  }
  for (const q of detail?.pendingQuestions ?? []) {
    asks.set(q.requestId, { requestId: q.requestId, questions: q.questions });
  }

  for (const e of events) {
    if (e.type !== 'tool_request') continue;
    if (e.call.kind === 'ask_human') {
      if (!answered.has(e.requestId)) {
        asks.set(e.requestId, { requestId: e.requestId, questions: e.call.questions });
      }
    } else if (!resolved.has(e.requestId)) {
      approvals.set(e.requestId, {
        requestId: e.requestId,
        rawInput: e.rawInput,
        call: e.call,
        policy: e.policy,
        preview: e.preview,
        destructive: e.destructive,
      });
    }
  }

  for (const id of resolved) approvals.delete(id);
  for (const id of answered) asks.delete(id);

  return { approvals: [...approvals.values()], asks: [...asks.values()] };
}

/**
 * Сколько карточек ждёт человека в очереди решений — одна формула для заголовка самой
 * очереди и для бейджа вкладки «Сейчас», иначе они расходятся при любой правке одного места.
 */
export function decisionQueueCount(
  asks: PendingAsk[],
  approvals: PendingCall[],
  decision: { label: string; artifact: string } | null,
): number {
  return asks.length + approvals.length + (decision !== null ? 1 : 0);
}
