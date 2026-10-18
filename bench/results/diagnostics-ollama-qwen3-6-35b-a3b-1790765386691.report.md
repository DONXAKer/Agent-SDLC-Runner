# Model diagnostics: ollama:qwen3.6:35b-a3b

Generated: 2026-09-30T10:49:46.688Z
Preflight exit code: 1
Preflight problem (model): модель: раскладка после прогрева: раскладка «qwen3.6-35b-a3b-ctx32k»: 57.5% GPU / 42.5% CPU — частичный офлоад. Модель не влезает в видеопамять целиком на этой раскладке; короткая проба этого не показывает — вскрывается только настоящей нагрузкой (длинный контекст, несколько запросов подряд).
Source: 641a832b7e8f637cdc4be2c85ee31e08168c5a40d71ef9b43a386d1e5e9316c8
Config: 94f416b0be98e6dabb2a40a4c9915c8d0e410c093d255cefdbb115948c714049

| Case | Task / stage | Input | Started | Mechanical result | Median time / tokens | Semantic review |
|---|---|---|---:|---|---:|---|
| V01 | oversize / verify | invalid-snapshot | 0/1 | 0/0 caught; invalid-snapshot: источники требований изменились после подготовки плана или в плане нет их отпечатка (ожидался SHA-256 5ea3631012bbbe3e35198be18c1b349b9dd057166b2d2e5fdc2e5a2325b5acc2); вернись на этап 4 и получи новое одобрение | t=—, tokens=— | not assessed |

## Known problem coverage

| Problem | Cases | Available inputs | Status |
|---:|---|---:|---|
| 1 | — | 0/0 | unmapped |
| 2 | — | 0/0 | unmapped |
| 3 | — | 0/0 | unmapped |
| 4 | — | 0/0 | unmapped |
| 5 | — | 0/0 | unmapped |
| 6 | — | 0/0 | unmapped |
| 7 | — | 0/0 | unmapped |
| 8 | — | 0/0 | unmapped |
| 9 | — | 0/0 | unmapped |
| 10 | — | 0/0 | unmapped |
| 11 | — | 0/0 | unmapped |
| 12 | — | 0/0 | unmapped |
| 13 | — | 0/0 | unmapped |
| 14 | — | 0/0 | unmapped |
| 15 | — | 0/0 | unmapped |
| 16 | — | 0/0 | outside model diagnosis |
| 17 | — | 0/0 | outside model diagnosis |
| 18 | — | 0/0 | outside model diagnosis |
| 19 | — | 0/0 | outside model diagnosis |
| 20 | — | 0/0 | outside model diagnosis |
| 21 | V01 | 0/1 | partial or unavailable inputs |
| 22 | V01 | 0/1 | partial or unavailable inputs |
| 23 | — | 0/0 | outside model diagnosis |
| 24 | — | 0/0 | outside model diagnosis |
| 25 | V01 | 0/1 | partial or unavailable inputs |
| 26 | — | 0/0 | unmapped |

## Suggestions

- Исправить среду или конфигурацию по preflight; результаты модельных кейсов не запускались.
- Подготовить и проверить отсутствующие снимки, чтобы расширить покрытие известных проблем.

Semantic quality must be reviewed against each case rubric; completion and runtime gates do not establish correctness.
