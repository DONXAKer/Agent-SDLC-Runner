import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { Script } from 'node:vm';
import assert from 'node:assert/strict';
import { renderRunFlow } from '../server/src/run/runFlow.ts';
import { guidedSuiteSuccess } from './guided-suite-success.ts';

const directory = resolve(process.argv[2]);
const manifest = JSON.parse(readFileSync(join(directory, 'suite.json'), 'utf8'));
assert.equal(manifest.status, 'complete'); assert.equal(manifest.runs.length, 6);
const baselineId = manifest.baseline ?? 'json-flow-final-20261009065718375';
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const rows = [];
let totalRequests = 0;
for (const [index, run] of manifest.runs.entries()) {
  const result = JSON.parse(readFileSync(resolve(directory, '..', `${run.slug}.json`), 'utf8'));
  const archived = readFileSync(resolve(directory, '..', '..', 'traces', run.slug, 'flow.html'), 'utf8');
  const report = JSON.parse(/<script id="flow-data" type="application\/json">([\s\S]*?)<\/script>/.exec(archived)[1]);
  const requests = report.entries.filter(entry => entry.kind === 'model_request');
  for (const request of requests) assert.ok(report.entries.some(entry => entry.kind === 'model_http' && entry.payload.requestId === request.payload.requestId), 'HTTP pair must be archived');
  const last = result.driver.stages.at(-1);
  const baselineSlug = `${baselineId}-m${Math.floor(index / 2) + 1}-t${index % 2 + 1}`;
  const baselineFile = resolve(directory, '..', `${baselineSlug}.json`);
  const baseline = existsSync(baselineFile) ? JSON.parse(readFileSync(baselineFile, 'utf8')) : null;
  const before = baseline?.driver.stages.at(-1);
  const success = guidedSuiteSuccess(result);
  const command = { command: process.execPath, args: run.args, codeHash: run.codeHash ?? null, model: run.model, task: run.task };
  report.entries.unshift({ id: 'suite-command', at: run.startedAt, invocation: null, stage: null, kind: 'bench_command', from: 'Серия', to: 'Стенд', payload: command });
  report.entries.push({ id: 'suite-result', at: run.finishedAt, invocation: null, stage: null, kind: 'bench_validation', from: 'Стенд', to: 'Результат', payload: {
    ok: success, driver: result.driver, finalVerdict: result.finalVerdict, hidden: result.hidden, honesty: result.honesty,
    comparison: { baseline: baselineSlug, lastStage: before?.stage, note: before?.note },
    log: readFileSync(join(directory, `${run.slug}.log`), 'utf8'),
  } });
  const stages = result.driver.stages.map(stage => `${stage.stage}: ${stage.skipped ? 'пропущен' : stage.ok ? 'пройден' : 'остановлен'}`).join(' → ');
  const hidden = result.hidden ? `${result.hidden.pass}/${result.hidden.total}; ошибок ${result.hidden.fail}, пропусков ${result.hidden.skipped}` : 'не запускались';
  const overview = `<aside style="margin:24px;padding:20px;border:1px solid #65758a;border-radius:8px"><h2>${escape(run.label)} · ${escape(run.task)}</h2><p><strong>${success ? 'Успешное решение' : 'Успешное решение не подтверждено'}</strong></p><p>${escape(stages)}</p><p><strong>Итог последнего этапа:</strong> ${escape(last?.note ?? result.driver.stopped)}</p><p>Скрытые тесты: ${escape(hidden)}. Вердикт: ${escape(result.finalVerdict?.passed ?? 'не получен')}. HTTP-запросов этапов: ${requests.length}.</p><p><strong>До исправлений:</strong> ${escape(before?.stage ?? 'нет данных')} — ${escape(before?.note ?? '')}</p><p>В схеме показаны реальные данные этапов Run. Преполёт и прогрев представлены журналом: их HTTP-тела не записывались. Проверка JSON и итоговые проверки результата показаны отдельно.</p><p><a href="index.html">Все шесть запусков</a> · <a href="${escape(run.slug)}.log">Полный журнал</a></p></aside>`;
  const html = renderRunFlow(report).replace('<main>', `${overview}\n<main>`);
  new Script(/<script>\n([\s\S]*?)<\/script>/.exec(html)[1]);
  assert.ok(html.includes('Вопрос → Данные → Ответ JSON'));
  writeFileSync(join(directory, `${run.slug}.html`), html);
  Object.assign(run, { success, lastStage: last?.stage, reason: last?.note, modelHttpRequests: requests.length, baseline: baselineSlug });
  totalRequests += requests.length;
  rows.push(`<tr><td>${escape(run.label)}</td><td>${escape(run.task)}</td><td>${escape(before?.stage ?? '—')}</td><td>${escape(stages)}</td><td>${escape(last?.note)}</td><td>${escape(hidden)}</td><td>${requests.length}</td><td><a href="${escape(run.slug)}.html">Схема запуска</a></td></tr>`);
}
const successes = manifest.runs.filter(run => run.success).length;
const hashes = [...new Set(manifest.runs.map(run => run.codeHash).filter(Boolean))];
const frozen = hashes.length === 1 && manifest.runs.every(run => run.codeHash);
const html = `<!doctype html><html lang="ru"><meta charset="utf-8"><title>Вопросы и JSON: результаты запусков</title><style>body{font:16px system-ui;background:#10151e;color:#e8eef7;padding:28px}table{border-collapse:collapse}td,th{padding:10px;border:1px solid #455572;vertical-align:top}a{color:#8cc4ff}p{max-width:1100px}</style><h1>Вопрос → JSON → документ</h1><p>${escape(manifest.id)} · завершены 6/6 · успешных решений ${successes}/6 · реальных HTTP-запросов этапов ${totalRequests}</p><p>Модели: GPT-OSS 20B, Ministral 3 14B, Qwen 3.8 27B IQ4. Задачи: add-validator и config-default. Пределы: 30 минут на этап, 60 минут на запуск, до трёх попыток реализации. Один запуск на сочетание модели и задачи.</p><p>Приём JSON по схеме не означает выполнение задачи. Успех считается только при завершённой передаче, положительном вердикте, полном прохождении скрытых тестов и проверок честности.</p><p>Сравнение с <a href="../${escape(baselineId)}/index.html">предыдущими шестью запусками</a>. ${frozen ? 'Во всех шести запусках одинаковый хэш исходного кода: ' + escape(hashes[0]) : 'Это промежуточная серия: одинаковая версия исходного кода для всех запусков не подтверждена.'}</p><table><thead><tr><th>Модель</th><th>Задача</th><th>До: последний этап</th><th>После: этапы</th><th>Причина / результат</th><th>Скрытые тесты</th><th>HTTP</th><th>HTML</th></tr></thead><tbody>${rows.join('')}</tbody></table><p>Каждый отчёт содержит команду, данные, схемы JSON, фактические HTTP-запросы и ответы, проверки, изменения файлов и полный журнал. Сырые результаты: bench/results/&lt;slug&gt;.json. Архивы: bench/traces/&lt;slug&gt;/. Рабочие копии сохранены.</p></html>`;
writeFileSync(join(directory, 'index.html'), html);
writeFileSync(join(directory, 'suite.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(JSON.stringify({ reports: manifest.runs.length, successes, totalRequests, frozen, report: join(directory, 'index.html') }));

