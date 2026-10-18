# Model diagnostics: ollama:granite4.2-8b-ctx32k-compactfill

Generated: 2026-09-30T12:09:32.555Z
Preflight exit code: 1
Preflight problem (model): модель: точный Edit многострочного блока: вызова нет, текст: «» (провал в 2/2 попыток)
Source: 394b7978f9aab3e2a82722a80b0787a72200d8566e183194558b0a2ffff5b844
Config: 8302275a5493c4617776ed4261aa1291e9e77aed5bc16766d165d14d0945389f

| Case | Task / stage | Input | Started | Mechanical result | Median time / tokens | Semantic review |
|---|---|---|---:|---|---:|---|
| I01 | oversize / intent | available | 0/1 | 0 run findings; available: fixture input | t=—, tokens=— | not assessed |
| I02 | contradiction / intent | available | 0/1 | 0 run findings; available: fixture input | t=—, tokens=— | not assessed |
| E01 | rename-field / explore | available | 0/1 | 0 run findings; available: rename-field-intent-reference | t=—, tokens=— | not assessed |
| E02 | multi-file-cascade / explore | missing-snapshot | 0/1 | 0 run findings; missing-snapshot: no validated multi-file-cascade snapshot after intent | t=—, tokens=— | not assessed |
| A01 | two-right-answers / ask | missing-snapshot | 0/1 | 0 run findings; missing-snapshot: no validated two-right-answers snapshot after explore | t=—, tokens=— | not assessed |
| A02 | impossible-without-data / ask | missing-snapshot | 0/1 | 0 run findings; missing-snapshot: no validated impossible-without-data snapshot after explore | t=—, tokens=— | not assessed |
| P01 | config-default / plan | missing-snapshot | 0/1 | 0 run findings; missing-snapshot: no validated config-default snapshot after ask | t=—, tokens=— | not assessed |
| P02 | migration-compat / plan | missing-snapshot | 0/1 | 0 run findings; missing-snapshot: no validated migration-compat snapshot after ask | t=—, tokens=— | not assessed |
| C01 | vat-rounding / chunk | available | 0/1 | 0 run findings; available: vat-rounding-plan-diagnostic-v2 | t=—, tokens=— | not assessed |
| C02 | rename-field / chunk | available | 0/1 | 0 run findings; available: rename-field-plan-diagnostic-v2 | t=—, tokens=— | not assessed |
| V00 | oversize / verify | available | 0/1 | 0/0 caught; available: oversize-axes3-diagnostic-v4 | t=—, tokens=— | not assessed |
| V01 | oversize / verify | available | 0/1 | 0/0 caught; available: oversize-axes3-diagnostic-v4 | t=—, tokens=— | not assessed |
| V02 | oversize / verify | available | 0/1 | 0/0 caught; available: oversize-axes3-diagnostic-v4 | t=—, tokens=— | not assessed |
| H01 | oversize / handoff | missing-snapshot | 0/1 | 0 run findings; missing-snapshot: oversize-verify-success: Error: ENOENT: no such file or directory, open 'D:\Проекты\Agent-SDLC-Runner\bench\snapshots\oversize-verify-success\snapshot.json' | t=—, tokens=— | not assessed |
| H02 | oversize / handoff | missing-snapshot | 0/1 | 0 run findings; missing-snapshot: no validated oversize snapshot after verify | t=—, tokens=— | not assessed |

## Known problem coverage

| Problem | Cases | Available inputs | Status |
|---:|---|---:|---|
| 1 | C01, C02 | 2/2 | inputs available |
| 2 | C01, C02 | 2/2 | inputs available |
| 3 | C01, C02 | 2/2 | inputs available |
| 4 | E01, E02 | 1/2 | partial or unavailable inputs |
| 5 | I01 | 1/1 | inputs available |
| 6 | P01, P02 | 0/2 | partial or unavailable inputs |
| 7 | I01, I02, C01 | 3/3 | inputs available |
| 8 | C01, C02 | 2/2 | inputs available |
| 9 | A01, A02 | 0/2 | partial or unavailable inputs |
| 10 | E01 | 1/1 | inputs available |
| 11 | C01, C02 | 2/2 | inputs available |
| 12 | C01, C02 | 2/2 | inputs available |
| 13 | C01, C02 | 2/2 | inputs available |
| 14 | I01 | 1/1 | inputs available |
| 15 | P01 | 0/1 | partial or unavailable inputs |
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
- Подготовить и проверить отсутствующие снимки, чтобы расширить покрытие известных проблем.

Semantic quality must be reviewed against each case rubric; completion and runtime gates do not establish correctness.
