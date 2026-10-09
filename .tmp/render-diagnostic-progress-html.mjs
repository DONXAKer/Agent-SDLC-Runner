import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { assessDiagnosticSample } from '../bench/src/diagnosticSample.ts';
const directory = process.argv[2];
const suite = JSON.parse(readFileSync(join(directory, 'suite.json'), 'utf8'));
const stageMinutes = suite.stageMinutes ?? 2;
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const rows = [];
const noteFor = (result, stage) => {
  const raw = stage?.note ?? '';
  if (result?.driver?.stopped === 'stage-timeout' || stage?.timedOut) {
    return `диагностический лимит этапа ${stageMinutes} мин`;
  }
  return raw;
};
for (const model of suite.models) {
  const summaries = model.summary ?? [];
  const preflightFail = summaries.some(s => s.preflight !== 0 && s.preflight != null);
  const caseSamples = summaries.flatMap(s => (s.cases ?? []).flatMap(c => c.samples ?? []));
  if (preflightFail && caseSamples.length === 0) {
    const report = (model.reports ?? [])[0];
    const preflightCodes = summaries.map(s => s.preflight).filter(c => c !== 0 && c != null);
    const artifacts = report
      ? `нет архива · <a href="../${escape(report)}">JSON</a>`
      : `<a href="${escape(model.log)}">Журнал</a>`;
    rows.push(`<tr><td>${escape(model.model)}</td><td>—</td><td>—</td><td>preflight красный, кейсы не запускались (код ${escape(preflightCodes.join(', ') || model.exitCode)})</td><td>см. журнал preflight</td><td>${artifacts}</td></tr>`);
    continue;
  }
  const log = readFileSync(join(directory, model.log), 'utf8');
  for (const match of log.matchAll(/Результат: `bench\/results\/([^`]+\.json)`/g)) {
    const file = match[1];
    const slug = file.replace(/\.json$/, '');
    const result = JSON.parse(readFileSync(join('bench/results', file), 'utf8'));
    const stage = result.driver.stages.at(-1);
    const caseId = /-(i\d+|e\d+|a\d+|p\d+|c\d+|v\d+|h\d+)-/.exec(file)?.[1];
    const assessed = assessDiagnosticSample(result, slug, 0, stage?.stage, caseId === 'h02', caseId === 'a01');
    const trace = existsSync(join('bench/traces', slug, 'flow.html')) ? `<a href="../../traces/${escape(slug)}/flow.html">Схема</a>` : 'нет архива';
    const outcome = ({ 'safely-blocked': 'ожидаемая блокировка без вызова модели', 'safely-skipped': 'ожидаемый пропуск без вызова модели', timeout: 'лимит времени', completed: 'механическая проверка пройдена', 'stage-failed': 'механическая проверка не пройдена', 'not-started': 'этап не стартовал', incomplete: 'не завершён' })[assessed.outcome] ?? assessed.outcome;
    rows.push(`<tr><td>${escape(model.model)}</td><td>${escape(caseId)}</td><td>${escape(stage?.stage)}</td><td>${escape(outcome)}${assessed.problemCodes?.length ? ': ' + escape(assessed.problemCodes.join(', ')) : ''}</td><td>${escape(noteFor(result, stage))}</td><td>${trace} · <a href="../${escape(file)}">JSON</a></td></tr>`);
  }
}
writeFileSync(join(directory, 'index.html'), `<!doctype html><html lang="ru"><meta charset="utf-8"><title>Диагностика перед guided-серией</title><style>body{font:16px system-ui;background:#10151e;color:#e8eef7;padding:28px}table{border-collapse:collapse}td,th{padding:10px;border:1px solid #455572;vertical-align:top}a{color:#8cc4ff}</style><h1>Диагностика перед guided-серией</h1><p>Состояние: ${escape(suite.status)}. Сохранено результатов: ${rows.length}. Обновлено: ${escape(new Date().toISOString())}.</p><p>Это изолированные этапы прежнего режима (preparationVersion=1), а не шесть полных guided-запусков. Лимит этапа: ${escape(stageMinutes)} минут; ${escape(suite.repeats ?? 5)} повторов каждого доступного кейса. Технический проход не доказывает правильность содержания. A01 законно пропускается рантаймом без вызова модели. При проверке с SDLC_STATE_DIR стенда доступны все 15 кейсов, включая H01/H02.</p><p>Фраза «этап отменён оператором» в исходной заметке при stopped=stage-timeout заменяется здесь на «диагностический лимит этапа» — это стендовый deadline, а не действие человека. Схемы открывают фактические архивы запросов, ответов и изменений файлов.</p><table><thead><tr><th>Модель</th><th>Кейс</th><th>Этап</th><th>Технический исход</th><th>Исходная заметка</th><th>Артефакты</th></tr></thead><tbody>${rows.join('')}</tbody></table></html>`);
console.log(JSON.stringify({ results: rows.length, index: join(directory, 'index.html'), stageMinutes }));
const summary = suite.models.map(model => `<li>${escape(model.model)}: ${escape(model.status)}${model.exitCode !== undefined ? ', код завершения ' + escape(model.exitCode) : ''}. <a href="${escape(model.log)}">Журнал, включая preflight</a>${(model.reports ?? []).map(file => ` · <a href="../${escape(file)}">Сводный JSON диагностики</a>`).join('')}</li>`).join('');
const indexPath = join(directory, 'index.html');
writeFileSync(indexPath, readFileSync(indexPath, 'utf8').replace('<table>', `<ul>${summary}</ul><table>`));
