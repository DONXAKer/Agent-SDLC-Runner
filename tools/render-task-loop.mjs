import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
const dir = resolve(process.argv[2] ?? 'bench/results/task-loop-smoke-local');
const escape = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
const result = existsSync(join(dir, 'result.json')) ? JSON.parse(readFileSync(join(dir, 'result.json'), 'utf8')) : null;
const manualAudit = existsSync(join(dir, 'manual-audit.json')) ? JSON.parse(readFileSync(join(dir, 'manual-audit.json'), 'utf8')) : null;
const revisedAssessment = existsSync(join(dir, 'assessment-revised.json')) ? JSON.parse(readFileSync(join(dir, 'assessment-revised.json'), 'utf8')) : null;
const independentPassed = result?.independent ? result.independent.total > 0 && result.independent.fail === 0 && result.independent.skipped === 0 && !result.independent.errorText : null;
const additionalPassed = manualAudit ? manualAudit.passed : independentPassed;
const overview = result ? { metrics: result.result.metrics,
  requirements: result.result.requirements ?? [],
  usage: result.passport.model === 'assistant-session' ? null : result.result.usage,
  usageNote: result.passport.model === 'assistant-session' ? 'Token accounting is unavailable for the manual session bridge.' : null,
  currency: result.result.currency, acceptance: result.acceptance, obligations: result.obligations,
  hidden: result.hidden, independent: result.independent ?? null, manualAudit, revisedAssessment, limitations: result.limitations } : {};
const events = readFileSync(join(dir, 'events.ndjson'), 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
const labels = { model_request: 'Запрос к модели', model_response: 'Ответ модели', tool_request: 'Вызов инструмента',
  tool_result: 'Результат инструмента', implementation_write: 'Файлы изменены', human_request: 'Вопрос человеку',
  human_answer: 'Ответ человека', baseline: 'Исходные проверки', model_work: 'Расход модели', model_request_failed: 'Сбой запроса модели', result: 'Итог', stop: 'Остановка', execution: 'Операция' };
function detail(e) {
  const p = e.payload ?? {};
  if (e.kind === 'requirement_evidence') return (p.requirements ?? []).map(r => `${r.id}: ${r.status}`).join(' · ');
  if (e.kind === 'tool_request') return `${p.call?.kind ?? ''} ${p.call?.path ?? ''} · ${p.decision?.allowed ? 'разрешено' : 'отказано'}`;
  if (e.kind === 'tool_result') return `${p.ok ? 'OK' : 'FAIL'} · ${p.summary ?? ''}`;
  if (e.kind === 'execution') return `${p.kind ?? ''} · ${p.phase ?? ''} · ${p.status ?? ''}`;
  if (e.kind === 'model_request') return p.model;
  if (e.kind === 'model_response') return `${p.finishReason ?? ''} · ${(p.toolCalls ?? []).map(c => c.name).join(', ')}`;
  if (e.kind === 'human_request') return (p.questions ?? []).map(q => q.question).join(' / ');
  if (e.kind === 'implementation_write' && p.toolOk === false) return 'Записано на диск; диагностика инструмента завершилась ошибкой';
  if (e.kind === 'model_request_failed') return p.error;
  if (e.kind === 'stop' || e.kind === 'result') return `${p.status ?? ''} · ${p.reason ?? ''}`;
  return '';
}
const rows = events.map(e => `<details data-kind="${escape(e.kind)}"><summary>${(e.elapsedMs / 1000).toFixed(2)} s · ${escape(labels[e.kind] ?? e.kind)} · ${escape(detail(e))}</summary><pre>${escape(JSON.stringify(e.payload, null, 2))}</pre></details>`).join('\n');
const summary = result ? `<p><strong>${result.result.metrics.modelRequests}</strong> запросов · <strong>${result.result.metrics.writes}</strong> учтённых правок · <strong>${(result.result.metrics.activeMs / 1000).toFixed(1)} с</strong> активного времени<br>Автоприёмка: <strong>${result.acceptance ? 'пройдена' : 'не пройдена'}</strong>. Дополнительная проверка: <strong>${additionalPassed === null ? 'нет результата' : additionalPassed ? 'пройдена' : 'найден дефект'}</strong>.</p>` : '';
writeFileSync(join(dir, 'flow.html'), `<!doctype html><html lang="ru"><meta charset="utf-8"><title>Task loop trace</title><style>body{font:16px system-ui;max-width:1100px;margin:24px auto;padding:0 20px;background:#10151e;color:#e4e9f2}input{padding:10px;width:90%;margin:16px 0}details{border:1px solid #364359;border-radius:6px;margin:8px 0;padding:10px}summary{cursor:pointer}pre{white-space:pre-wrap;overflow-wrap:anywhere;font:13px monospace}small{color:#a9b9cd}</style><h1>Короткий цикл: лента</h1>${summary}<p>${escape(result ? `${result.passport.task} · ${result.passport.model} · ${result.result.status}` : 'Прогон ещё идёт')}</p><small>Готовность к проверке и прохождение набора тестов не доказывают все требования.</small><details><summary>Метрики, автоматическая оценка и дополнительное ревью</summary><pre>${escape(JSON.stringify(overview, null, 2))}</pre></details><input id="filter" placeholder="Фильтр событий: model_request, tool_result, check…">${rows}<script>document.getElementById('filter').addEventListener('input',e=>{const q=e.target.value.toLowerCase();document.querySelectorAll('details[data-kind]').forEach(d=>d.hidden=!(d.dataset.kind+' '+d.textContent).toLowerCase().includes(q));});</script></html>`);
console.log(join(dir, 'flow.html'));
