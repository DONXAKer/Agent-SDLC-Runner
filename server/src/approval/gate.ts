/**
 * Гейт одобрений: держит промис, пока оператор не ответит.
 *
 * Два разных «нет» здесь не смешиваются:
 *
 *  - **отказ политики** — жёсткий. Оператор его снять не может, потому что политика это
 *    конструкция, а не рекомендация. Такой вызов даже не попадает в очередь на одобрение;
 *  - **отказ оператора** — решение человека, и оно фиксируется как таковое.
 *
 * Тумблер «одобрить всё для этапа» существует, потому что на chunk'е иначе придётся
 * кликать сто раз. Он не отключает политику — только человеческий шаг, и факт его
 * включения попадает в журнал этапа.
 */

import { evaluate } from '../policy/index.ts';
import type {
  Decision,
  DiffPreview,
  NormalizedCall,
  PolicyContext,
  PolicyVerdict,
  StageId,
} from '../types.ts';
import { buildPreview } from './preview.ts';

export interface PendingApproval {
  runId: string;
  stage: StageId;
  requestId: string;
  call: NormalizedCall;
  policy: PolicyVerdict;
  preview: DiffPreview | null;
  createdAt: number;
}

interface Waiting extends PendingApproval {
  resolve: (d: Decision) => void;
}

export interface GateEvents {
  onPending: (p: PendingApproval) => void;
  /**
   * Прогон и этап передаются явно, а не выводятся из requestId: идентификатор вызова
   * приходит от исполнителя и о нашем прогоне ничего не знает. Угадывание владельца по
   * подстроке при двух живых витках отправило бы событие не в тот.
   */
  onResolved: (
    info: { runId: string; stage: StageId; requestId: string },
    decision: Decision,
  ) => void;
}

export class ApprovalGate {
  private readonly waiting = new Map<string, Waiting>();
  /** Владелец каждого выданного requestId — чтобы событие о разрешении дошло по адресу. */
  private readonly owner = new Map<string, { runId: string; stage: StageId }>();
  /** Этапы, для которых оператор включил автоодобрение. */
  private readonly autoStages = new Set<string>();
  private readonly events: GateEvents;

  constructor(events: GateEvents) {
    this.events = events;
  }

  private key(runId: string, stage: StageId): string {
    return `${runId}:${stage}`;
  }

  setAutoApprove(runId: string, stage: StageId, on: boolean): void {
    const k = this.key(runId, stage);
    if (on) this.autoStages.add(k);
    else this.autoStages.delete(k);
  }

  isAutoApprove(runId: string, stage: StageId): boolean {
    return this.autoStages.has(this.key(runId, stage));
  }

  list(): PendingApproval[] {
    return [...this.waiting.values()].map(({ resolve: _resolve, ...rest }) => rest);
  }

  /**
   * Основной путь вызова инструмента. Возвращает решение; политика считается первой и
   * обжалованию не подлежит.
   */
  async request(args: {
    runId: string;
    stage: StageId;
    requestId: string;
    call: NormalizedCall;
    ctx: PolicyContext;
  }): Promise<Decision> {
    const policy = evaluate(args.call, args.ctx);
    const preview = buildPreview(args.call, args.ctx.projectRoot);
    const info = { runId: args.runId, stage: args.stage, requestId: args.requestId };
    this.owner.set(args.requestId, { runId: args.runId, stage: args.stage });

    if (!policy.ok) {
      const decision: Decision = {
        allowed: false,
        reason: `[${policy.policy}] ${policy.reason}`,
        by: 'policy',
      };
      this.events.onPending({ ...args, policy, preview, createdAt: Date.now() });
      this.events.onResolved(info, decision);
      return decision;
    }

    // Чтение, поиск и вопросы человеку не проходят человеческое одобрение: их цена нулевая,
    // а сто подтверждений подряд превращают гейт в кликанье не глядя.
    if (args.call.kind === 'read' || args.call.kind === 'glob' || args.call.kind === 'grep') {
      return { allowed: true, updatedInput: null, by: 'auto' };
    }

    if (this.isAutoApprove(args.runId, args.stage)) {
      const decision: Decision = { allowed: true, updatedInput: null, by: 'auto' };
      this.events.onPending({ ...args, policy, preview, createdAt: Date.now() });
      this.events.onResolved(info, decision);
      return decision;
    }

    return new Promise<Decision>((resolve) => {
      const pending: Waiting = { ...args, policy, preview, createdAt: Date.now(), resolve };
      this.waiting.set(args.requestId, pending);
      const { resolve: _r, ...visible } = pending;
      this.events.onPending(visible);
    });
  }

  /** Ответ оператора. `false` — такого запроса нет (уже разрешён или устарел). */
  resolve(requestId: string, decision: Decision): boolean {
    const w = this.waiting.get(requestId);
    if (w === undefined) return false;
    this.waiting.delete(requestId);
    this.owner.delete(requestId);
    this.events.onResolved({ runId: w.runId, stage: w.stage, requestId }, decision);
    w.resolve(decision);
    return true;
  }

  /** Снимает все ожидающие запросы прогона — при отмене или обрыве этапа. */
  cancelRun(runId: string, reason: string): void {
    for (const [id, w] of [...this.waiting.entries()]) {
      if (w.runId !== runId) continue;
      this.waiting.delete(id);
      this.owner.delete(id);
      const decision: Decision = { allowed: false, reason, by: 'operator' };
      this.events.onResolved({ runId: w.runId, stage: w.stage, requestId: id }, decision);
      w.resolve(decision);
    }
  }
}
