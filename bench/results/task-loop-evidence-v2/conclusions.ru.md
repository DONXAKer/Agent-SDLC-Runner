# Выводы серии task-loop-evidence-v2

Модель: `ollama:qwen3.8-27b-iq4-gpumax`. 8 задач × 2 плеча × 1 повтор = 16. Каталог: этот.

| Режим | Автоприёмка | False success | Hidden timeout | Abandoned needs_input | Среднее, с |
|---|---:|---:|---:|---:|---:|
| local | 7/8 | 0 | 0 | 1 | 97 |
| evidence | 6/8 | 0 | 0 | 2 | 113 |

Mitigations закрыли ложную готовность и патологию cent-split. Evidence **не** лучше local; **не** включать по умолчанию.

Отказы: оба option-overlay — `__proto__` / needs_input на шумном visible; evidence-cent-split — верный код (hidden 2/2), но speculative AskHuman → needs_input.

Следующая серия (≥3 повтора) — только после правок AskHuman/visible/`__proto__` task: новый каталог, тот же протокол, evidence по-прежнему опциональный замер.
