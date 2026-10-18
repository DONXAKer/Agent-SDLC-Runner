# Model diagnostics: ollama:qwen3.8-27b-iq4-gpumax

Generated: 2026-10-09T15:40:58.874Z
Preflight exit code: 1
Preflight problem (model): модель: заполнение поля через Edit: вызван Read вместо Edit (провал в 2/2 попыток)
Source: ae801a0ce16331767d1cbf1d97d1e92be3a89b3315b315012556f60f4a8b4789
Config: df16bc81e5d656e2686efe9fdec267e5c615a1ab0db23f7cf67a89130ccda6b7

| Case | Task / stage | Input | Started | Mechanical result | Median time / tokens | Semantic review |
|---|---|---|---:|---|---:|---|
| A02 | impossible-without-data / ask | available | 0/1 | 0 run findings; available: impossible-without-data-explore-reviewed-v1 | t=—, tokens=— | not assessed |

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
| 9 | A02 | 1/1 | inputs available |
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
| 21 | — | 0/0 | unmapped |
| 22 | — | 0/0 | unmapped |
| 23 | — | 0/0 | outside model diagnosis |
| 24 | — | 0/0 | outside model diagnosis |
| 25 | — | 0/0 | unmapped |
| 26 | — | 0/0 | unmapped |

## Suggestions

- Исправить среду или конфигурацию по preflight; результаты модельных кейсов не запускались.

Semantic quality must be reviewed against each case rubric; completion and runtime gates do not establish correctness.
