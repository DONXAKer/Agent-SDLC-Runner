# Model diagnostics: ollama:ministral3-14b-instruct-ctx32k-compactfill

Generated: 2026-10-09T11:21:44.196Z
Preflight exit code: 1
Preflight problem (model): модель: точный Edit многострочного блока: old_string не совпал с файлом побайтово: «Срок: ${days} дн.
» (провал в 2/2 попыток)
Preflight problem (model): модель: правка поля без перезаписи файла: old_string не совпал с файлом побайтово: «| src/a.ts | ‹что там сейчас› |» (провал в 2/2 попыток)
Source: e98ea04d65f97c8c4a4069a502635afbba08d2b18a54ab29dfd171b714b30c3c
Config: 943c7c8eab76d50eea02d5a63230a4a4402ebc8b404745538c8cc547514ef64f

| Case | Task / stage | Input | Started | Mechanical result | Median time / tokens | Semantic review |
|---|---|---|---:|---|---:|---|
| I01 | oversize / intent | available | 0/5 | 0 run findings; available: fixture input | t=—, tokens=— | not assessed |
| I02 | contradiction / intent | available | 0/5 | 0 run findings; available: fixture input | t=—, tokens=— | not assessed |
| E01 | rename-field / explore | available | 0/5 | 0 run findings; available: rename-field-intent-reference | t=—, tokens=— | not assessed |
| E02 | multi-file-cascade / explore | available | 0/5 | 0 run findings; available: diagnostic-multi-file-cascade-intent-v1 | t=—, tokens=— | not assessed |
| A01 | two-right-answers / ask | available | 0/5 | 0 run findings; available: two-right-answers-explore-reviewed-v1: expected conditional skip | t=—, tokens=— | not assessed |
| A02 | impossible-without-data / ask | available | 0/5 | 0 run findings; available: impossible-without-data-explore-reviewed-v1 | t=—, tokens=— | not assessed |
| P01 | config-default / plan | available | 0/5 | 0 run findings; available: config-default-plan-reference-v4 | t=—, tokens=— | not assessed |
| P02 | migration-compat / plan | available | 0/5 | 0 run findings; available: migration-compat-plan-reference-v4 | t=—, tokens=— | not assessed |
| C01 | vat-rounding / chunk | available | 0/5 | 0 run findings; available: vat-rounding-plan-diagnostic-v2 | t=—, tokens=— | not assessed |
| C02 | rename-field / chunk | available | 0/5 | 0 run findings; available: rename-field-plan-diagnostic-v2 | t=—, tokens=— | not assessed |
| V00 | oversize / verify | available | 0/5 | 0/0 caught; available: oversize-axes3-diagnostic-v4 | t=—, tokens=— | not assessed |
| V01 | oversize / verify | available | 0/5 | 0/0 caught; available: oversize-axes3-diagnostic-v4 | t=—, tokens=— | not assessed |
| V02 | oversize / verify | available | 0/5 | 0/0 caught; available: oversize-axes3-diagnostic-v4 | t=—, tokens=— | not assessed |
| H01 | oversize / handoff | available | 0/5 | 0 run findings; available: matrix-h01-gemma-v2-clean | t=—, tokens=— | not assessed |
| H02 | oversize / handoff | available | 0/5 | 0 run findings; available: matrix-h01-gemma-v2-clean-missing-verdict: expected missing runtime verdict | t=—, tokens=— | not assessed |

## Known problem coverage

| Problem | Cases | Available inputs | Status |
|---:|---|---:|---|
| 1 | C01, C02 | 2/2 | inputs available |
| 2 | C01, C02 | 2/2 | inputs available |
| 3 | C01, C02 | 2/2 | inputs available |
| 4 | E01, E02 | 2/2 | inputs available |
| 5 | I01 | 1/1 | inputs available |
| 6 | P01, P02 | 2/2 | inputs available |
| 7 | I01, I02, C01 | 3/3 | inputs available |
| 8 | C01, C02 | 2/2 | inputs available |
| 9 | A01, A02 | 2/2 | inputs available |
| 10 | E01 | 1/1 | inputs available |
| 11 | C01, C02 | 2/2 | inputs available |
| 12 | C01, C02 | 2/2 | inputs available |
| 13 | C01, C02 | 2/2 | inputs available |
| 14 | I01 | 1/1 | inputs available |
| 15 | P01 | 1/1 | inputs available |
| 16 | — | 0/0 | outside model diagnosis |
| 17 | — | 0/0 | outside model diagnosis |
| 18 | — | 0/0 | outside model diagnosis |
| 19 | — | 0/0 | outside model diagnosis |
| 20 | — | 0/0 | outside model diagnosis |
| 21 | V00, V01, V02 | 3/3 | inputs available |
| 22 | V00, V01, V02 | 3/3 | inputs available |
| 23 | — | 0/0 | outside model diagnosis |
| 24 | — | 0/0 | outside model diagnosis |
| 25 | V00, V01, V02 | 3/3 | inputs available |
| 26 | C01 | 1/1 | inputs available |

## Suggestions

- Исправить среду или конфигурацию по preflight; результаты модельных кейсов не запускались.

Semantic quality must be reviewed against each case rubric; completion and runtime gates do not establish correctness.
