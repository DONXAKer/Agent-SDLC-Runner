/**
 * Входы этапов — какие артефакты этап читает. Отдельным файлом: его зовёт сборка промпта,
 * которой модули этапов (и рантайм за ними) не нужны.
 */

import type { StageId } from '@sdlc-runner/shared';
import type { StageContext, StageDef, StageInput, StageOutputContract } from './types.ts';

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
  const req = (path: string): StageInput => inputContract(id, path, false);
  const opt = (path: string): StageInput => inputContract(id, path, true);

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
        // Запись о свидетельствах: рецензент видит, чем и от какой базы сняты улики.
        opt(p.chunkEvidence(c.chunk, c.attempt)),
        // Ответ человека на блокирующий вопрос задачи (этап 3) может уточнять требование,
        // которое приёмочный лист intent.md после этого не обновляли (Р6, серия local6
        // 2026-09-24): рецензент без этого входа судит код против буквы устаревшего claim-N,
        // не зная, что код следует более позднему решению человека. Тот же вход, что уже
        // читает `plan` (`stageInputs('plan')` выше) — второго места сборки не заводится.
        opt(p.clarificationReport),
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

function inputContract(stage: StageId, path: string, optional: boolean): StageInput {
  const name = (path.split(/[\\/]/).at(-1) ?? path).toLowerCase();
  const origin: StageInput['origin'] = name === 'gates.md' ? 'project'
    : name === 'intent.md' ? 'operator'
    : name.includes('chunk-') || name.includes('journal') ? 'runtime'
    : name === 'clarification-report.md' ? 'ask'
    : name === 'exploration-report.md' ? 'explore'
    : name === 'readiness.md' ? (stage === 'explore' ? 'intent' : 'plan')
    : name === 'plan.md' ? 'plan'
    : name === 'verification-report.md' ? 'verify'
    : 'runtime';
  const freshness: StageInput['freshness'] = origin === 'project' ? 'live'
    : (stage === 'chunk' || stage === 'verify' || stage === 'handoff') && name === 'plan.md' ? 'approved'
    : name.includes('chunk-') || name.includes('journal') ? 'attempt'
    : 'current-run';
  return { path, optional, origin, freshness, purpose: stageArtifactPurpose(stage, path, 'input') };
}

export function stageOutputContracts(def: StageDef, c: StageContext): StageOutputContract[] {
  const required = def.produces(c);
  const all = [...new Set([...required, ...(def.evidence?.(c) ?? [])])];
  return all.map((path) => ({
    path,
    purpose: stageArtifactPurpose(def.id, path, 'output'),
    origin: def.id,
    required: required.includes(path),
    freshness: /(?:chunk|attempt)-\d+/i.test(path) ? 'attempt' : 'current-run',
  }));
}

export function stageArtifactPurpose(stage: StageId, path: string, direction: 'input' | 'output'): string {
  const name = (path.split(/[\\/]/).at(-1) ?? path).toLowerCase();
  const input: Partial<Record<StageId, Record<string, string>>> = {
    intent: { 'gates.md': 'выбрать применимые проверки и обязательные ограничения процесса' },
    explore: {
      'intent.md': 'разобрать приёмочные требования и заявленные границы работы',
      'readiness.md': 'учесть известные риски и ограничения подготовки',
      'gates.md': 'соблюдать применимые проверки проекта',
    },
    ask: {
      'intent.md': 'найти открытые требования и вопросы к человеку',
      'exploration-report.md': 'уточнить возникшие при разведке неоднозначности',
    },
    plan: {
      'intent.md': 'связать план с исходными требованиями и пунктами приёмки',
      'readiness.md': 'учесть риски и ограничения готовности',
      'exploration-report.md': 'использовать найденные файлы, символы и зависимости',
      'clarification-report.md': 'соблюсти ответы и решения человека',
    },
    chunk: {
      'plan.md': 'следовать одобренным шагам и контрактам',
    },
    verify: {
      'intent.md': 'проверить каждый пункт приёмки против результата',
      'plan.md': 'сверить фактические изменения с одобренным объёмом и контрактом',
      'gates.md': 'выполнить настроенные проверки проекта',
      'clarification-report.md': 'сверить решение с ответами человека',
    },
    handoff: {
      'intent.md': 'зафиксировать цель и критерии передачи',
      'plan.md': 'зафиксировать одобренный объём и принятые риски',
      'gates.md': 'указать настроенные условия передачи',
    },
  };
  if (direction === 'input') {
    const exact = input[stage]?.[name];
    if (exact !== undefined) return exact;
    if (name.includes('chunk-') && name.includes('diff')) return 'сравнить текущую попытку с предыдущей работой';
    if (name.includes('chunk-') && name.includes('test')) return 'учесть результаты проверок уже выполненной попытки';
    if (name.includes('chunk-') && name.includes('evidence')) return 'проверить происхождение и базу свидетельств попытки';
    if (name.includes('journal')) return 'восстановить ход и нерешённые замечания прошлой попытки';
    return 'контекст этапа; использовать только факты, нужные для его решения';
  }
  if (name === 'intent.md') return 'исходные требования и пункты приёмки следующего этапа';
  if (name === 'readiness.md') return 'состояние готовности и известные риски';
  if (name === 'exploration-report.md') return 'адресация кода, последствия и найденные зависимости';
  if (name === 'clarification-report.md') return 'записанные ответы человека и уточнения требований';
  if (name === 'plan.md') return 'одобренный порядок шагов, проверок и контрактов';
  if (name === 'verification-report.md') return 'свидетельства и итоговая оценка реализации';
  if (name === 'handoff.md') return 'решение и запись о передаче результата';
  if (name.endsWith('.diff') || name.endsWith('.patch')) return 'снимок фактических изменений для проверки';
  if (name.includes('review')) return 'результат независимой проверки изменений';
  if (name.includes('journal')) return 'машинная запись состояния и проверок попытки';
  return 'результат этапа, на который опираются последующие решения';
}
