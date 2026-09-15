/** Этап 7 — передача: определение этапа и проверка зелёного отчёта приёмки. */

import { DECISION, artifactExists, readArtifact } from '../../artifacts/artifact.ts';
import { relOf } from './preconditions.ts';
import type { StageContext, StageDef } from './types.ts';

/** Отчёт приёмки последней попытки говорит, что виток принят. */
function verificationPassed(c: StageContext): boolean {
  const report = readArtifact(c.paths.verificationReport(c.chunk, c.attempt));
  if (!report.exists) return false;
  // Markdown-жирность обязана прощаться: сама форма методологии пишет `- **passed:** true`
  // (templates/verification-report.template.md, секция «Вердикт») — прежний regex не
  // признавал КАНОНИЧЕСКИЙ зелёный отчёт зелёным, и handoff отказывался от передачи
  // ровно на первом же успешном витке. Якорь — НАЧАЛО строки (плюс маркер списка):
  // `passed: true`, процитированный в прозе отчёта («в шаблоне написано …»), не должен
  // открывать передачу непринятого витка.
  return /^\s*[-*>\s]*[*_]*passed[*_]*\s*[:=]\s*[*_]*\s*true/im.test(report.text);
}

export const handoffStage: StageDef = {
  id: 'handoff',
  skill: 'sdlc-handoff',
  title: 'Передача',
  tools: ['Read', 'Glob', 'Grep', 'Write', 'Edit', 'Bash', 'AskHuman', 'FinalizeArtifact', 'FillField'],
  subagents: [],
  produces: (c) => [c.paths.handoff],
  requires: [
    // Методология требует на входе вердикт passed=true и приёмку человека. Handoff
    // при этом пишется и при обрыве витка — но обрыв это осознанное решение оператора,
    // а не то, во что можно свалиться, дёрнув этап из любого состояния. Поэтому обрыв
    // разрешается явным флагом, а по умолчанию нужен зелёный отчёт приёмки.
    {
      describe: 'отчёт приёмки с passed=true (или явно объявленный обрыв витка)',
      artifact: (c) => c.paths.verificationReport(c.chunk, c.attempt),
      check: (c) => {
        if (verificationPassed(c)) return null;
        const report = c.paths.verificationReport(c.chunk, c.attempt);
        return artifactExists(report)
          ? `вердикт в ${report} не passed=true. Коммит из этого состояния методология ` +
              `запрещает: возврат на доработку или эскалация, но не передача. Чтобы ` +
              `оформить обрыв витка, запусти этап с флагом «обрыв».`
          : `нет отчёта приёмки ${report}. Передача без вердикта возможна только как ` +
              `обрыв витка — запусти этап с флагом «обрыв».`;
      },
    },
  ],
  // gates.md здесь править можно: методология велит дописывать сюда строку долга.
  protectedArtifacts: (c) => [relOf(c, c.paths.plan), relOf(c, c.paths.intent)],
  humanGate: { artifact: 'handoff', label: DECISION.accepted },
  skipIf: null,
};
