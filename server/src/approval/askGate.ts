/**
 * Вопросы человеку.
 *
 * Отдельно от гейта одобрений, потому что это другое действие: там человек разрешает или
 * запрещает уже сформированный вызов, здесь — сообщает недостающее знание. Методология
 * называет разницу так: «какая толщина стены — не вопрос к заказчику; где он хочет
 * розетку — вопрос».
 */

import type { Question, StageId } from '@sdlc-runner/shared';

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

  /** Ключ включает прогон — по тем же причинам, что и в гейте одобрений. */
  answer(
    runId: string,
    requestId: string,
    answers: Record<string, string[]>,
    note?: string,
  ): boolean {
    const w = this.waiting.get(requestId);
    if (w === undefined || w.runId !== runId) return false;
    this.waiting.delete(requestId);
    // Примечание оператора едет ВНУТРИ ответов: оба исполнителя отдают модели только
    // answers (loop — JSON.stringify, sdk — тем же объектом), отдельного канала для
    // пояснения нет. Живой виток ta-13: оператор выбрал «нужны правки» и написал какие
    // в note — модель получила голый label и переспросила, сжигая ход и деньги.
    const merged =
      note !== undefined && note.trim() !== ''
        ? { ...answers, 'примечание оператора': [note.trim()] }
        : answers;
    this.events.onAnswered({ runId: w.runId, stage: w.stage, requestId }, merged);
    w.resolve(merged);
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
