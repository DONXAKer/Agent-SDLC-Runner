# Сводка находимости посевов

| Класс посева | Ожидание | claude-sdk:haiku | claude-sdk:opus | claude-sdk:sonnet | ollama:gpt-oss-20b | ollama:gpt-oss-20b-ctx32k-mt | ollama:gpt-oss-20b-effort-high | ollama:gpt-oss-20b-effort-low | ollama:gpt-oss-20b-effort-low-rf | ollama:gpt-oss-20b-rf |
|---|---|---|---|---|---|---|---|---|---|---|
| ось: настройки — значение из окружения без умолчания (`axis-config-blind`) | review | 1/1 | 1/1 | 0/2 | 0/1 | 0/1 | — | 0/1 | 0/1 | 0/2 |
| ось: безопасность — данные заказа в логе (`axis-secret-in-log`) | review | 1/1 | 1/1 | 1/2 | 0/1 | 0/2 | — | 0/1 | 0/1 | 0/2 |
| логика правила: потеряно измерение (`dimension-sum-drops-third`) | review | — | — | — | — | — | — | — | 0/1 | 0/1 |
| логика правила: потеряно измерение (`longest-side-drops-third`) | review | — | — | — | — | — | — | — | 0/1 | 0/1 |
| регрессия: молчаливая правка прейскуранта (`silent-price-change`) | review | — | — | — | — | — | — | — | 1/1 | 1/1 |
| отключённый ассерт (контроль стенда) (`skip-existing-test`) | gate | — | — | — | — | — | — | — | 1/1 | 1/1 |
| проглоченная ошибка (`swallow-tariff-error`) | review | — | — | — | — | — | — | — | 0/1 | 0/1 |
| off-by-one на границе (контроль стенда) (`weight-step-off-by-one`) | gate | — | — | — | — | — | — | — | 1/1 | 1/1 |

## Контроль без посева (`none`) — ложные срабатывания

| Модель | Ложных / прогонов |
|---|---|
| claude-sdk:haiku | 0/1 |
| claude-sdk:opus | 0/1 |
| claude-sdk:sonnet | 0/1 |
| ollama:gpt-oss-20b | 0/1 |
| ollama:gpt-oss-20b-ctx32k-mt | 0/2 |
| ollama:gpt-oss-20b-effort-high | 0/1 |
| ollama:gpt-oss-20b-effort-low | 0/1 |
| ollama:gpt-oss-20b-effort-low-rf | 1/1 |
| ollama:gpt-oss-20b-rf | 3/8 |

Исключено из знаменателя (код 2 либо отчёт не строится на этом результате): 25

- axes-ff-axis-config-blind: измерение не состоялось (код 2)
- axes-qwen38-axis-config-blind: измерение не состоялось (код 2)
- axes-qwen38-none: измерение не состоялось (код 2)
- day-gpt-oss-20b-effort-high-rf-axis-config-blind: измерение не состоялось (код 2)
- day-gpt-oss-20b-effort-high-rf-axis-secret-in-log: измерение не состоялось (код 2)
- day-gpt-oss-20b-effort-high-rf-dimension-sum-drops-third: измерение не состоялось (код 2)
- day-gpt-oss-20b-effort-high-rf-longest-side-drops-third: измерение не состоялось (код 2)
- day-gpt-oss-20b-effort-high-rf-none: измерение не состоялось (код 2)
- day-gpt-oss-20b-effort-high-rf-silent-price-change: измерение не состоялось (код 2)
- day-gpt-oss-20b-effort-high-rf-skip-existing-test: измерение не состоялось (код 2)
- day-gpt-oss-20b-effort-high-rf-swallow-tariff-error: измерение не состоялось (код 2)
- day-gpt-oss-20b-effort-high-rf-weight-step-off-by-one: измерение не состоялось (код 2)
- t2-apriel-1-6-15b-rf-dimension-sum-drops-third: измерение не состоялось (код 2)
- t2-apriel-1-6-15b-rf-longest-side-drops-third: измерение не состоялось (код 2)
- t2-apriel-1-6-15b-rf-none: измерение не состоялось (код 2)
- t2-apriel-1-6-15b-rf-silent-price-change: измерение не состоялось (код 2)
- t2-apriel-1-6-15b-rf-swallow-tariff-error: измерение не состоялось (код 2)
- t2-apriel-1-6-15b-rf-weight-step-off-by-one: измерение не состоялось (код 2)
- t3-apriel-rf-none-v2: измерение не состоялось (код 2)
- t3-qwen38iq4rf-none-v2: измерение не состоялось (код 2)
- w2-apriel-none: измерение не состоялось (код 2)
- w2-apriel-rf-none: измерение не состоялось (код 2)
- w2-qwen38iq4-none: измерение не состоялось (код 2)
- w2-qwen38iq4rf-none: измерение не состоялось (код 2)
- w3-apriel-rf-r11-none: измерение не состоялось (код 2)
