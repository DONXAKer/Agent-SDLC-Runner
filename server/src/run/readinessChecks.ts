import { existsSync } from 'node:fs';

import type { StageContext } from './stages/types.ts';
import { readArtifact, readField, hasNamedInvariants } from '../artifacts/artifact.ts';
import { countClaims } from '../artifacts/claims.ts';
import { configProblems, parseGates } from '../gates/gatesFile.ts';
import { splitRow } from '../md/table.ts';
import { hasOpenQuestions, intentPlaceholdersOutsideTouch, intentTamperedSections, isSmallContour } from './stages/preconditions.ts';
import { CLAIMS_MINIMUM } from '../artifacts/claims.ts';

export interface ReadinessCheckResult {
  checks: string;
  ready: boolean;
}

function filled(value: string | null): boolean {
  return value !== null && value.trim() !== '' && !/[‹›]/u.test(value);
}

function claimRows(intent: string): string[] {
  return intent.split(/\r?\n/u).filter((line) => /^\s*\|\s*`?claim-\d+\b/iu.test(line));
}

function verifiableClaims(intent: string): boolean {
  const rows = claimRows(intent);
  return rows.length > 0 && rows.every((line) => {
    const cells = splitRow(line);
    const procedure = cells.at(-1)?.trim() ?? '';
    return procedure.length >= 12 && !/[‹›]/u.test(procedure);
  });
}

export function readinessRun1(c: StageContext): ReadinessCheckResult {
  const intent = readArtifact(c.paths.intent);
  const gates = readArtifact(c.paths.gates);
  const text = intent.exists ? intent.text : '';
  const gateProblems = gates.exists ? configProblems(parseGates(gates.text)) : ['файл гейтов отсутствует'];
  const gateOk = gateProblems.length === 0;
  const scopeOk = filled(readField(text, 'Что делаем')) && filled(readField(text, 'Чего не делаем'));
  const counts = countClaims(text);
  const small = isSmallContour(c);
  const claimsOk = counts.rows >= (small ? 1 : CLAIMS_MINIMUM.rows) && counts.edges >= (small ? 0 : CLAIMS_MINIMUM.edges);
  const checksOk = verifiableClaims(text);
  const invariantsOk = hasNamedInvariants(text);
  const questionsOk = !hasOpenQuestions(text);
  const placeholders = intent.exists ? intentPlaceholdersOutsideTouch(text) : 1;
  const ready = gateOk && scopeOk && claimsOk && checksOk && invariantsOk && questionsOk && placeholders === 0;
  const checks = [
    `гейты ${gateOk ? '✅' : `❌ (${gateProblems.length})`}`,
    `границы задачи ${scopeOk ? '✅' : '❌'}`,
    `приёмка ${claimsOk ? '✅' : '❌'} (${counts.rows} пунктов, ${counts.edges} [edge])`,
    `процедуры проверки ${checksOk ? '✅' : '❌'}`,
    `инварианты ${invariantsOk ? '✅' : '❌'}`,
    `ответы на блокирующие вопросы ${questionsOk ? '✅' : '❌'}`,
    `плейсхолдеры ${placeholders === 0 ? '✅' : `❌ (${placeholders})`}`,
  ].join('; ');
  return { checks, ready };
}

export function readinessRun2(c: StageContext): ReadinessCheckResult {
  const intent = readArtifact(c.paths.intent);
  const exploration = readArtifact(c.paths.explorationReport);
  const text = intent.exists ? intent.text : '';
  const open = hasOpenQuestions(text) || (exploration.exists && hasOpenQuestions(exploration.text));
  const touch = readField(text, 'Что придётся тронуть');
  const touchOk = isSmallContour(c) || filled(touch);
  const counts = countClaims(text);
  const small = isSmallContour(c);
  const claimsOk = counts.rows >= (small ? 1 : CLAIMS_MINIMUM.rows) && counts.edges >= (small ? 0 : CLAIMS_MINIMUM.edges);
  const structureOk = claimsOk && verifiableClaims(text);
  const intentPlaceholders = intent.exists ? intentPlaceholdersOutsideTouch(text) : 1;
  const remaining = intentPlaceholders + (touchOk ? 0 : 1) + (exploration.exists ? (exploration.placeholders ?? 0) : 0);
  const snapshotExists = existsSync(c.paths.intentSections);
  const tampered = intentTamperedSections(c);
  const examplesOk = snapshotExists && tampered === null;
  const ready = !open && remaining === 0 && touchOk && structureOk && examplesOk;
  const checks = [
    `блокирующие вопросы ${open ? '❌' : '✅'}`,
    `плейсхолдеры ${remaining === 0 ? '✅' : `❌ (${remaining})`}`,
    `разведка заполнила файлы ${touchOk ? '✅' : '❌'}`,
    `критерии изменялись ${examplesOk ? 'нет; пересчёт не нужен' : 'да; требуется пересчёт'}`,
    `структура и [edge] ${structureOk ? '✅' : `❌ (${counts.rows}/${counts.edges})`}`,
  ].join('; ');
  return { checks, ready };
}
