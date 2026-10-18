import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, basename, resolve } from 'node:path';
const dir = resolve(process.argv[2] ?? 'bench/results/task-loop-comparison');
const json = path => existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null;
const suite = json(join(dir, 'suite.json'));
const samplingTransition = json(join(dir, 'sampling-transition.json'));
const gradingTransition = json(join(dir, 'evaluation-transition.json'));
const environment = json(join(dir, 'environment.json'));
const postSeries = json(join(dir, 'post-series-changes.json'));
const retrospective = json(join(dir, 'retrospective.json'));
const details = suite.runs.filter(r => !['pending', 'running'].includes(r.status)).map(cell => {
  const result = json(cell.arm === 'baseline' ? join('bench/results', `${basename(dir)}-${cell.output}.json`) : join(dir, cell.output, 'result.json'));
  return { ...cell,
    hiddenOutcome: cell.hiddenOutcome ?? result?.hiddenOutcome ?? null,
    hiddenError: cell.hiddenError ?? result?.hidden?.errorText ?? null,
    readyWithUnverifiedRequirements: result?.readyWithUnverifiedRequirements === true
      || (result?.result?.status === 'ready_for_review' && Array.isArray(result?.result?.requirements)
        && result.result.requirements.some(r => r.status === 'unverified')),
    note: result?.result?.reason ?? result?.driver?.stages?.findLast(s => !s.ok)?.note ?? null,
    firstEditMs: result?.result?.metrics?.firstEditMs ?? result?.execution?.timeToFirstMutationMs ?? null,
    requests: result?.result?.metrics?.modelRequests ?? result?.metrics?.stages?.reduce((n, s) => n + (s.requestDurationsMs?.length ?? 0), 0) ?? null,
    usage: cell.arm === 'reference' ? null : result?.result?.usage ?? result?.metrics?.stages?.map(s => ({ stage: s.stage, usage: s.usage })) ?? null,
    metrics: result?.result?.metrics ?? null,
    independent: result?.independent ?? null,
    manualAudit: json(join(dir, cell.output, 'manual-audit.json')),
    boundaryViolations: result?.boundaryViolations ?? json(join(dir, cell.output, 'assessment.json'))?.boundaryViolations ?? null,
  };
});
const complete = details.length === suite.runs.length;
const arms = ['local', 'evidence', 'baseline', 'reference'].filter(arm => suite.runs.some(r => r.arm === arm)).map(arm => {
  const runs = details.filter(r => r.arm === arm);
  return { arm, completed: runs.length, expected: suite.runs.filter(r => r.arm === arm).length, automaticAcceptance: runs.filter(r => r.acceptance).length,
    automaticFalseSuccess: runs.filter(r => r.falseSuccess === true).length,
    knownFalseSuccess: runs.filter(r => r.falseSuccess === true || r.manualAudit?.passed === false).length,
    additionalConfirmedDefects: runs.filter(r => r.manualAudit?.passed === false).length,
    abandonedForQuestion: runs.filter(r => r.status === 'needs_input').length,
    abandonedDespiteHiddenPass: runs.filter(r => r.status === 'needs_input' && r.hiddenOutcome === 'pass').length,
    hiddenFailRejects: runs.filter(r => r.hiddenOutcome === 'fail' || (r.falseSuccess === true && r.hiddenOutcome !== 'timeout')).length,
    hiddenTimeoutRejects: runs.filter(r => r.hiddenOutcome === 'timeout' || (r.falseSuccess === true && /таймаут|timed out/iu.test(r.hiddenError ?? ''))).length,
    readyWithUnverifiedRequirements: runs.filter(r => r.readyWithUnverifiedRequirements === true).length,
    meanSeconds: runs.length ? runs.reduce((n, r) => n + (r.activeMs ?? 0), 0) / runs.length / 1000 : null };
});
const repeatableTasks = [...new Set(details.filter(r => r.arm === 'local').map(r => r.task))].filter(task =>
  details.filter(r => r.arm === 'local' && r.task === task && r.acceptance && r.falseSuccess !== true && r.manualAudit?.passed !== false).length === 2);
const aggregates = {
  abandonedForQuestion: arms.reduce((n, a) => n + a.abandonedForQuestion, 0),
  abandonedDespiteHiddenPass: arms.reduce((n, a) => n + a.abandonedDespiteHiddenPass, 0),
  hiddenFailRejects: arms.reduce((n, a) => n + a.hiddenFailRejects, 0),
  hiddenTimeoutRejects: arms.reduce((n, a) => n + a.hiddenTimeoutRejects, 0),
  readyWithUnverifiedRequirements: arms.reduce((n, a) => n + a.readyWithUnverifiedRequirements, 0),
};
const summary = { version: 3, complete, sourceHash: suite.sourceHash, capturedAt: new Date().toISOString(), arms, aggregates, repeatableTasks, retrospective, details };
writeFileSync(join(dir, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
const rows = arms.map(a => `| ${a.arm} | ${a.completed}/${a.expected} | ${a.completed ? `${a.automaticAcceptance}/${a.completed}` : '—'} | ${a.knownFalseSuccess} | ${a.abandonedForQuestion} | ${a.abandonedDespiteHiddenPass} | ${a.hiddenFailRejects} | ${a.hiddenTimeoutRejects} | ${a.readyWithUnverifiedRequirements} | ${a.meanSeconds?.toFixed(1) ?? '—'} |`).join('\n');
const defects = details.filter(r => r.manualAudit?.passed === false).map(r => `- ${r.output}: ${r.manualAudit.requirement}. Проверка: \`${r.manualAudit.inputExpression}\`. Получено: \`${r.manualAudit.actualType === 'undefined' ? 'undefined' : JSON.stringify(r.manualAudit.actual)}\`. [Протокол](${r.output}/manual-audit.json).`).join('\n');
const report = `# Результаты пилота короткого цикла

${complete ? 'Серия завершена.' : `Промежуточный отчёт: ${details.length}/${suite.runs.length}; ожидающие прогоны не считаются провалами.`}

Модель: ${suite.localModel}. Задач: ${new Set(suite.runs.map(r => r.task)).size}, повторов: ${Math.max(...suite.runs.map(r => r.repeat))}, активный лимит: ${suite.activeTimeoutMs / 60000} мин. Режимы: ${arms.map(a => a.arm).join(', ')}. Конфигурация: ${suite.casesFile ?? 'bench/experiments/task-loop-cases.json'}. Исторические результаты других серий не являются сопоставимым контролем этой серии. Режим evidence **не** включён по умолчанию в продукт — только замер в этой серии.

| Режим | Выполнено | Автоприёмка | Ложная готовность | Abandoned (needs_input) | Из них при hidden pass | Hidden fail | Hidden timeout | Ready + unverified | Среднее время, с |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
${rows}

Итого: abandoned_for_question **${aggregates.abandonedForQuestion}** (из них despite hidden pass **${aggregates.abandonedDespiteHiddenPass}**), hidden fail **${aggregates.hiddenFailRejects}**, hidden timeout **${aggregates.hiddenTimeoutRejects}**, ready с unverified **${aggregates.readyWithUnverifiedRequirements}**. \`needs_input\` не смешивается с false success. Requirements с пустым \`checks\` (например full-contract) остаются advisory и не блокируют ready_for_review.

${retrospective ? `Отдельная ретроспективная оценка усиленными проверками: **${retrospective.revisedPassed}/${retrospective.total}**, исходная автоматическая оценка — ${retrospective.originalPassed}/${retrospective.total}. Генерация не повторялась; новые проверки добавлены после ревью, поэтому этот пересчёт не является слепым экспериментом. [Протокол и причины отказов](retrospective.json).\n` : ''}
Локальная модель прошла оба повтора без выявленной ошибки: ${repeatableTasks.length ? repeatableTasks.join(', ') : 'пока ни одной завершённой пары'}. Отсутствие выявленной ошибки не доказывает её отсутствие.

## Дополнительное ревью после прогона

${defects || 'Дополнительных подтверждённых дефектов пока нет.'}

Эти проверки выполнены после завершения моделей, не входили в исходный скрытый набор и не передавались генератору. Их результаты не переписывают исходный показатель автоприёмки. Одинаковые дополнительные входы проверены на локальных и контрольных решениях.

Столбец ошибок после заявления готовности объединяет отказы автоматической приёмки после ready_for_review и подтверждённые дополнительные дефекты, без двойного счёта. Исходный automaticFalseSuccess сохранён отдельно в JSON. Сам статус ready_for_review означает готовность к ревью, а не обещание полной корректности.

## Ограничения и воспроизводимость

${samplingTransition ? `- Первые локальные запуски принудительно задавали температуру 0, а baseline наследовал серверную 0.15. Они исключены из сравнения и сохранены как [диагностика](temperature-zero-diagnostic.json). Все локальные ячейки ${complete ? 'повторно выполнены' : 'повторяются'} с тем же способом задания параметров, что в baseline; [протокол](sampling-transition.json).\n` : ''}
- Автоприёмка: готовность/завершение плюс неизменённые скрытые тесты, границы, обязательные вопросы, дополнительно исполненные тесты и нужная правка документации. Смысл документации требует ревью.
- При наличии acceptanceFile его независимые проверки также входят в автоматическую приёмку; они фиксируются до генерации и выполняются только после остановки модели. Дерево при оценивании должно оставаться неизменным.
${gradingTransition ? '- В оценке v1 наличие нового теста ошибочно определялось по новому файлу. Оценка v2 проверяет прирост исполненных успешных тестов, в том числе в существующем разрешённом файле. Пересчитаны все завершённые решения, сохранены исходные оценки. При этом пересчёте исполнитель, модель, фикстуры и скрытые тесты не менялись: [протокол перехода](evaluation-transition.json).\n' : ''}
${suite.runs.some(r => r.arm === 'reference') ? '- Контроль reference выполнен текущим ассистентом через тот же LoopExecutor. Контекст задач был известен; во втором повторе применялись ранее подготовленные решения после чтения исходников. Это контроль интерфейса и повторяемости исполнения, НЕ независимые замеры качества модели. Его токены и стоимость неизвестны; время включает работу с мостом и не сравнивает скорость моделей.' : '- Серия содержит только явно выбранные режимы. Контроль текущим ассистентом в эту серию не входит.'}
- Локальная цена неизвестна: null не заменяется нулём. Два повтора одной задачи не заменяют разнообразный holdout.
${environment?.performanceIsolation ? `- Условия измерения времени: ${environment.performanceIsolation}\n` : ''}
${postSeries ? '- В исходной телеметрии этой серии не учитывались записи с последующей ошибкой диагностики. После серии учёт исправлен; [протокол изменений](post-series-changes.json), [финальная валидация](final-validation.json). Измеренная версия исходников сохранена отдельно, результаты не пересчитаны под новую телеметрию.' : ''}
- Проверки пилота поддерживают зарегистрированные Node-команды и исходно зелёное дерево. Это ещё не универсальная поддержка произвольного проекта. Дообучение и включение по умолчанию не проводились.

Построчный статус: [report.md](report.md). Полные данные: [suite.json](suite.json), [summary.json](summary.json), [environment.json](environment.json). В каталогах local/reference сохранены events.ndjson, passport.json, result.json, patch-files и tracked.patch. [Обзор с лентами](index.html).
`;
writeFileSync(join(dir, 'summary.ru.md'), report);
const escape = value => String(value ?? '—').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
for (const r of details.filter(r => r.arm !== 'baseline')) {
  const render = spawnSync(process.execPath, ['tools/render-task-loop.mjs', join(dir, r.output)], { encoding: 'utf8', windowsHide: true });
  if (render.status !== 0) throw new Error(render.stderr);
}
const links = suite.runs.map(r => {
  const detail = details.find(d => d.output === r.output);
  const independent = detail?.independent;
  const additional = detail?.manualAudit ? detail.manualAudit.passed ? 'Пройдено' : 'Дефект'
    : independent ? independent.total > 0 && independent.fail === 0 && independent.skipped === 0 && !independent.errorText ? `Пройдено ${independent.pass}/${independent.total}` : `FAIL ${independent.pass}/${independent.total}` : null;
  const href = r.arm === 'baseline' ? `${r.output}/process.log` : `${r.output}/flow.html`;
  const hiddenCell = detail?.hiddenOutcome && detail.hiddenOutcome !== 'pass'
    ? `${r.hidden ?? '—'} (${detail.hiddenOutcome}${detail.hiddenError ? `: ${String(detail.hiddenError).slice(0, 80)}` : ''})`
    : (r.hidden ?? '—');
  return `<tr><td>${escape(r.arm)}</td><td>${escape(r.task)}</td><td>${r.repeat}</td><td>${escape(r.status)}</td><td>${escape(r.acceptance)}</td><td>${escape(additional)}</td><td>${escape(hiddenCell)}</td><td>${detail ? `<a href="${href}">Лента</a>` : '—'}</td></tr>`;
}).join('\n');
writeFileSync(join(dir, 'index.html'), `<!doctype html><html lang="ru"><meta charset="utf-8"><title>Пилот короткого цикла</title><style>body{font:16px system-ui;max-width:1250px;margin:30px auto;padding:0 20px;background:#10151e;color:#e4e9f2}table{border-collapse:collapse;width:100%}th,td{text-align:left;padding:10px;border-bottom:1px solid #364359}a{color:#9dc9ff}input{padding:10px;margin:18px 0;width:60%}p{max-width:1000px;line-height:1.5}</style><h1>Пилот короткого цикла: ${details.length}/${suite.runs.length}</h1>${retrospective ? `<p><strong>Исходная автоматическая оценка: ${retrospective.originalPassed}/${retrospective.total}. Усиленная: ${retrospective.revisedPassed}/${retrospective.total}.</strong> Пересчёт сохранённых решений после ревью; генерация не повторялась. <a href="retrospective.json">Протокол</a> · <a href="conclusions.ru.md">Выводы</a></p>` : ""}<p>Автоприёмка и дополнительное ревью показаны отдельно. ${suite.runs.some(r => r.arm === 'reference') ? 'Reference — текущий ассистент с известным контекстом; это не независимый контроль качества модели.' : 'Серия включает только выбранные режимы; исторические результаты не являются сопоставимым контролем.'} Evidence не включён в продукт по умолчанию. Бакеты: abandoned(needs_input)=${aggregates.abandonedForQuestion} (despite hidden pass ${aggregates.abandonedDespiteHiddenPass}), hidden fail=${aggregates.hiddenFailRejects}, timeout=${aggregates.hiddenTimeoutRejects}, ready+unverified=${aggregates.readyWithUnverifiedRequirements}.</p><p><a href="summary.ru.md">Полный отчёт и ограничения</a> · <a href="summary.json">Данные</a></p><input id="filter" placeholder="Фильтр задач, режимов и статусов"><table><thead><tr><th>Режим</th><th>Задача</th><th>Повтор</th><th>Статус</th><th>Автоприёмка</th><th>Доп. проверка</th><th>Скрытые</th><th>Лог</th></tr></thead><tbody>${links}</tbody></table><script>document.querySelector('#filter').addEventListener('input',e=>document.querySelectorAll('tbody tr').forEach(r=>r.hidden=!r.textContent.toLowerCase().includes(e.target.value.toLowerCase())));</script></html>`);
console.log({ complete, finished: details.length, arms, aggregates, repeatableTasks });
