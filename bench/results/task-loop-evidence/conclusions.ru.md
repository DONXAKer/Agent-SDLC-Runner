# Промежуточные выводы: local vs evidence

Дата среза: 2026-10-14. Источники: [summary.ru.md](summary.ru.md), [summary.json](summary.json), [evidence-metrics.json](evidence-metrics.json), [suite.json](suite.json), [protocol.md](protocol.md).

## Решение: догнать эту же серию

**Догоняем текущую серию**, не стартуем новую.

Основания:

- `sourceHash` серии `ac37171789249cde7ce329964e0c61006e863f6000e650b2476dbe1d1dc71d5a` совпадает с текущим отпечатком исходников (`sourceFingerprint`). Менять runtime mid-flight нельзя: сравнение local/evidence останется сопоставимым только при том же хеше.
- Завершено 8/48 (только repeat 1 у четырёх задач × два плеча). `local-page-window-1` помечен `interrupted` (`Stopped by operator`) и **не** перезапускается автоматически — так задумано в `compare-task-loop.ts`. Очередь продолжается со следующего `pending` (`evidence-page-window-1` и далее).
- В каталоге лежит `STOP_AFTER_CURRENT`: перед догоном его нужно снять, иначе очередь сразу остановится.

Команда догона (без смены модели/флагов/кейсов):

```powershell
Remove-Item bench/results/task-loop-evidence/STOP_AFTER_CURRENT -ErrorAction SilentlyContinue
node tools/compare-task-loop.ts --run --arms local,evidence --repeats 3 --cases-file bench/experiments/task-loop-evidence.json --output bench/results/task-loop-evidence --model ollama:qwen3.8-27b-iq4-gpumax
node tools/render-task-loop-comparison.mjs bench/results/task-loop-evidence
```

Если исходники под отпечатком изменятся — **новая серия в другом каталоге**, не правка этой.

### Обновление после правок 2026-10-14

После среза внесены общие mitigations (таймаут registered check в executor, `maxRepeatedErrors` в пилоте, эскалация стратегии при повторах, `__proto__` в visible `option-overlay`). Они **меняют `sourceHash`** — догон старой серии `ac371717…` больше невозможен. Следующий замер: **новая серия** в отдельном каталоге (или переименование текущего архива и чистый output). Гипотезу local vs evidence по-прежнему меряем без включения evidence по умолчанию.

## Срез 8/48

Модель: `ollama:qwen3.8-27b-iq4-gpumax`. Активный лимит 10 мин, 40 ходов.

| Задача | local | evidence |
|---|---|---|
| range-union | accept, hidden 2/2 | accept, 2/2 |
| option-overlay | false success, 1/2 | false success, 1/2 |
| csv-cell | accept, 2/2 | accept, 2/2 (1 repair) |
| cent-split | accept, 2/2 | false success, 0/0 (timeout оценки) |

Агрегат: local **3/4** автоприёмка / 1 ложная готовность (~82 с); evidence **2/4** / 2 ложные готовности (~155 с). Запросы: 27 vs 51; repairAttempts: 0 vs 6.

Гипотезу «evidence лучше local» этот срез **не поддерживает**. Решение о включении evidence по умолчанию **не принимается** до завершения серии (или хотя бы полного круга повторов) по критерию из [protocol.md](protocol.md).

## Что этот пилот не измеряет

Серия меряет только формат обратной связи в коротком `TaskLoopExecutor` (plain check text vs requirement-linked structured feedback). Она **не** валидирует guided JSON/recovery ветки `integration/guided-model-recovery` (#2). Guided-фиксы проверяются отдельным guided-suite, не этим каталогом. См. [docs/task-loop-pilot.md](../../docs/task-loop-pilot.md).

## Классы ложной готовности на срезе

1. **Дыра вне visible** — `option-overlay`: оба плеча одинаково заявили `ready_for_review` при провале H2 на ключе `"__proto__"`. Feedback бессилен, пока кейс не в видимых проверках.
2. **Repair → патологический алгоритм → timeout hidden** — `evidence-cent-split-1`: подробно в [findings-cent-split.md](findings-cent-split.md). Local на той же задаче прошёл с простым `floor`/`%`.

`ready_for_review` + зелёные visible **не** считать успехом без независимой скрытой приёмки — пилот как раз это ловит.

[Сводка](summary.ru.md) · [Обзор](index.html) · [Метрики evidence](evidence-metrics.json) · [Среда](environment.json)
