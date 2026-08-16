/**
 * Вопросы человеку.
 *
 * Отдельно от гейта одобрений, потому что это другое действие: там человек разрешает или
 * запрещает уже сформированный вызов, здесь — сообщает недостающее знание. Методология
 * называет разницу так: «какая толщина стены — не вопрос к заказчику; где он хочет
 * розетку — вопрос».
 */

import type { Question, StageId } from '../types.ts';

export interface PendingQuestions {
  runId: string;
  stage: StageId;
  requestId: string;
  questions: Question[];
  createdAt: number;
}

interface Waiting extends PendingQuestions {
  resolve: (answers: Record<string, string[]>) => void;
}

export interface AskGateEvents {
  onPending: (p: PendingQuestions) => void;
  /** Прогон и этап передаются явно — по тем же причинам, что и в гейте одобрений. */
  onAnswered: (
    info: { runId: string; stage: StageId; requestId: string },
    answers: Record<string, string[]>,
  ) => void;
}

export class AskGate {
  private readonly waiting = new Map<string, Waiting>();
  private readonly events: AskGateEvents;
  private counter = 0;

  constructor(events: AskGateEvents) {
    this.events = events;
  }

  list(): PendingQuestions[] {
    return [...this.waiting.values()].map(({ resolve: _r, ...rest }) => rest);
  }

  ask(args: {
    runId: string;
    stage: StageId;
    questions: Question[];
  }): Promise<Record<string, string[]>> {
    const requestId = `ask-${args.runId}-${++this.counter}`;
    return new Promise((resolve) => {
      const w: Waiting = { ...args, requestId, createdAt: Date.now(), resolve };
      this.waiting.set(requestId, w);
      const { resolve: _r, ...visible } = w;
      this.events.onPending(visible);
    });
  }

  answer(requestId: string, answers: Record<string, string[]>): boolean {
    const w = this.waiting.get(requestId);
    if (w === undefined) return false;
    this.waiting.delete(requestId);
    this.events.onAnswered({ runId: w.runId, stage: w.stage, requestId }, answers);
    w.resolve(answers);
    return true;
  }

  cancelRun(runId: string): void {
    for (const [id, w] of [...this.waiting.entries()]) {
      if (w.runId !== runId) continue;
      this.waiting.delete(id);
      // Пустой ответ — это «пропущено», а не «согласен». Скиллы методологии трактуют
      // отсутствие ответа именно так и записывают «(пропущено)» в отчёт.
      const answers: Record<string, string[]> = {};
      this.events.onAnswered({ runId: w.runId, stage: w.stage, requestId: id }, answers);
      w.resolve(answers);
    }
  }
}
