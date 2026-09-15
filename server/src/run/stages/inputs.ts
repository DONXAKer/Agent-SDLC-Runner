/**
 * Входы этапов — какие артефакты этап читает. Отдельным файлом: его зовёт сборка промпта,
 * которой модули этапов (и рантайм за ними) не нужны.
 */

import type { StageId } from '@sdlc-runner/shared';
import type { StageContext, StageInput } from './types.ts';

/**
 * Артефакты, которые этап читает на входе. Они подклеиваются в пользовательское сообщение
 * целиком: методология требует, чтобы этап работал по файлам, а не по пересказу
 * предыдущего этапа.
 *
 * Этап 6 отдельно: журнала chunk'а здесь нет. Журнал — это рассказ исполнителя («что
 * чинили, что изменилось против предыдущей попытки»), а методология перечисляет входы
 * рецензента исчерпывающе: задача, план, набор гейтов и diff. Связь с предыдущей попыткой
 * несут только `retry_instruction` и `carry_forward`, и их подаёт машина витка, а не файл.
 */
export function stageInputs(id: StageId, c: StageContext): StageInput[] {
  const p = c.paths;
  const req = (path: string): StageInput => ({ path, optional: false });
  const opt = (path: string): StageInput => ({ path, optional: true });

  switch (id) {
    case 'intent':
      return [opt(p.gates)];
    case 'explore':
      return [req(p.intent), req(p.readiness), opt(p.gates)];
    case 'ask':
      return [req(p.intent), opt(p.explorationReport)];
    case 'plan':
      return [
        req(p.intent),
        req(p.readiness),
        opt(p.explorationReport),
        opt(p.clarificationReport),
      ];
    case 'chunk':
      return [
        req(p.plan),
        opt(p.chunkJournal(c.chunk)),
        // Предыдущая попытка существует только начиная со второй: на первой этого пути
        // нет и быть не может, и просить `attempt-0` бессмысленно.
        //
        // Только ОДИН прошлый патч. Второй (K−2) подавался ради детекта отсутствия
        // прогресса, который методология поручала модели (Phase 0 chunk'а), — но его
        // считает рантайм (`detectNoProgress`, дословное сравнение патчей), и результат
        // уже приходит в выжимке ретрая. Два патча по 40 КБ на окне 16k вытесняли
        // сам план и правила — модель получала много байт и мало смысла.
        ...(c.attempt > 1 ? [opt(p.chunkDiff(c.chunk, c.attempt - 1))] : []),
      ];
    case 'verify':
      return [
        req(p.intent),
        req(p.plan),
        req(p.gates),
        req(p.chunkDiff(c.chunk, c.attempt)),
        opt(p.chunkTests(c.chunk, c.attempt)),
      ];
    case 'handoff':
      return [
        req(p.intent),
        req(p.plan),
        req(p.gates),
        opt(p.verificationReport(c.chunk, c.attempt)),
        opt(p.chunkJournal(c.chunk)),
      ];
  }
}
