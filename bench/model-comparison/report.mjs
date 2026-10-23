import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

export function renderComparison(directory) {
  const m = JSON.parse(readFileSync(join(directory, 'manifest.json'), 'utf8'));
  const clean = value => String(value ?? '—').replaceAll('|', '\\|').replace(/[\r\n]+/g, ' ');
  const rows = (items, columns) => items.map(item => '| ' + columns.map(c => clean(c(item))).join(' | ') + ' |').join('\n');
  const text = `# Сравнение моделей и настроек\n\n` +
    `Статус: **${m.status}**. Начало: ${m.startedAt}. Завершение: ${m.finishedAt ?? 'ещё выполняется'}.\n` +
    `GPU-бюджет: ${m.budgetMinutes} минут; использовано ${m.elapsedMinutes?.toFixed(1) ?? 'измеряется'}.\n` +
    `Отпечаток исходников: \`${m.sourceHash}\`. Старый пилот не возобновлялся.\n\n` +
    `## Исполнители: короткий скрининг\n\n| Вариант | Статус | Проверки | GPU-размещение | Причина |\n|---|---|---|---|---|\n` +
    rows(m.candidates, [c=>c.id,c=>c.status,c=>c.total === undefined ? '—' : `${c.correct}/${c.total}`,c=>c.warmup ? c.warmup.fullyGpu : 'не измерено',c=>c.error ??
      (c.status === 'parameter-unverified' ? JSON.stringify({ reasoning: c.reasoningObservation, cache: c.cacheObservation }) : c.warnings?.join('; '))]) +
    `\n\nУспех скрининга не означает успех полного процесса. Пробы используют штатный provider и PREFLIGHT_CASES.\n\n` +
    `## Судьи: независимые типизированные решения\n\n| Модель | Набор | Статус | Верно/валидно/всего | Ложное разрешение scope | Ложная блокировка scope | Неподтверждённые утверждения | Brier | ECE | P50/P95 валидных ответов, мс | Причина |\n|---|---|---|---|---|---|---|---|---|---|\n` +
    rows(m.decisions, [c=>c.id,c=>c.split,c=>c.status,c=>c.metrics ? `${c.metrics.correct}/${c.metrics.valid}/${c.metrics.total}` : '—',c=>c.metrics?.falseAllow,c=>c.metrics?.falseBlock,c=>c.metrics?.unsupported,
      c=>c.metrics?.brier?.toFixed(3),c=>c.metrics?.ece?.toFixed(3),c=>c.metrics ? `${c.metrics.validLatencyP50Ms}/${c.metrics.validLatencyP95Ms}` : '—',c=>c.error ?? c.rows.find(r=>r.error)?.error]) +
    `\n\n60 заранее размеченных RU/EN примеров: 30 диагностических и 30 отложенных. Эталоны не передаются модели. Отложенный набор получает только лучший завершивший диагностику судья. Калибровочные параметры авторов не подгоняются к этому набору.\n\n` +
    `## Полные guided v4 / prep3 циклы\n\n| Модель | Задача | Статус | Этап | Скрытые проверки | Причина |\n|---|---|---|---|---|---|\n` +
    rows(m.fullRuns,[c=>c.model,c=>c.task,c=>c.status,c=>c.failedStage,c=>JSON.stringify(c.hidden),c=>c.reason]) +
    `\n\nВыбраны исполнители: ${(m.selectedExecutors ?? []).join(', ') || 'нет прошедших скрининг'}. Судья: ${m.selectedJudge ?? 'не выбран'}.\n\n` +
    `Не запущены: исполнители ${(m.unstartedExecutors ?? []).join(', ') || '—'}; судьи ${(m.unstartedJudges ?? []).join(', ') || '—'}; полные циклы ${JSON.stringify(m.unstartedFullRuns ?? [])}.\n\n` +
    `## Ограничения и воспроизведение\n\n` +
    m.limitations.map(l=>`- ${l}`).join('\n') + '\n' +
    `- Seed: ${m.seed.status}; ${m.seed.reason}\n` +
    `- Ошибка запуска, отсутствие памяти и неполный результат отделены от неправильного ответа модели.\n` +
    `- Для вывода о надёжности нужны дополнительные независимые задачи и повторы. По этой серии основные профили автоматически не меняются.\n\n` +
    `Подготовка: \`node bench/model-comparison/prepare.mjs .tmp/model-comparison-20261019 --download\`.\n` +
    `Запуск после подготовки окружений: \`node bench/model-comparison/run.mjs <новый-каталог-результатов>\`.\n` +
    `Полные параметры, ошибки, времена и хеши находятся в manifest.json; сырые запросы — в *.requests.ndjson и raw/.\n`;
  writeFileSync(join(directory, 'summary.ru.md'), text);
}
if (process.argv[1] && resolve(process.argv[1]) === import.meta.filename) renderComparison(resolve(process.argv[2]));
