import { readFileSync, writeFileSync } from 'node:fs';
import { digest } from '../bench/src/diagnostics.ts';
const catalog = 'bench/diagnostics/semantic-assessments.json';
const data = JSON.parse(readFileSync(catalog, 'utf8'));
function add(caseId, slug, rationale, evidence) {
  const resultFile = `bench/results/${slug}.json`;
  const record = { caseId, resultFile, resultHash: digest(readFileSync(resultFile)), outcome: 'fail', rationale,
    evidence: evidence.map(([path, quote]) => {
      const text = readFileSync(path, 'utf8');
      if (!text.includes(quote)) throw new Error(`Missing quote: ${path}: ${quote}`);
      return { path, sha256: digest(readFileSync(path)), quote };
    }) };
  data.assessments = data.assessments.filter((r) => !(r.caseId === caseId && r.resultFile === resultFile));
  data.assessments.push(record);
}
add('input:P01', 'matrix-p01-v3',
  'Механически завершены intent/explore/ask, но карта приписывает изменения README файлу src/invoice.ts, а таблица переиспользования содержит скопированные подсказки. Вход P01 не принят по содержанию.', [
  ['bench/traces/matrix-p01-v3/artifacts/exploration-report.md', '| src/invoice.ts | README.md |'],
  ['bench/traces/matrix-p01-v3/artifacts/exploration-report.md', '| resolveConfig | src/config.ts:resolveConfig | что делает | как используем |'],
]);
const slug = 'diag-ollama-gemma4-12b-compactfill-v00-1790777277405-1';
add('V00', slug,
  'Чистый контроль отклонён из-за логирования в scripts/build-check.mjs. Scope-гейт подтверждает, что файл существовал в базе chunk и не менялся в попытке. Эта находка не доказывает расхождение новой реализации с осью плана; V00 не пройден.', [
  [`bench/traces/${slug}/artifacts/verification-report-1-attempt-1.md`, 'вне плана, из базы chunk\'а (не работа этапа): scripts/build-check.mjs'],
  [`bench/traces/${slug}/artifacts/verification-report-1-attempt-1.md`, '«Наблюдаемость» — в плане объявлена не затронутой, а diff её трогает'],
]);
add('input:P02', 'matrix-p02-qwen-v2',
  'Фикстура требует ответа человека со ставкой по умолчанию 20. Explore оставил заглушку вопроса «Текст вопроса?», вопрос условного этапа ask не был задан, clarification-report содержит незаполненные поля. Снимок для plan не принят.', [
  ['bench/snapshots/matrix-p02-qwen-v2-after-ask-c1-a1/.sdlc/matrix-p02-qwen-v2/clarification-report.md', '| 1 | Текст вопроса? | да | Ответа у меня нет'],
  ['bench/snapshots/matrix-p02-qwen-v2-after-ask-c1-a1/.sdlc/matrix-p02-qwen-v2/intent.md', 'Добавляем поле `vatRate`'],
]);
add('H01', 'matrix-h01-v2',
  'Runtime verdict passed, но verification-report остался с семью placeholders. Снимок непригоден для следующего handoff и не принят как H01.', [
  ['bench/traces/matrix-h01-v2/artifacts/verification-report-1-attempt-1.md', '- **passed:** true'],
  ['bench/traces/matrix-h01-v2/run-state.json', '"note": "ход модели пропущен: reviewFill прошёл конвейер целиком'],
]);
writeFileSync(catalog, JSON.stringify(data, null, 2) + '\n');
