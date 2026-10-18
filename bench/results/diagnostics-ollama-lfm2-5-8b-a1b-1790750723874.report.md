# Model diagnostics: ollama:lfm2.5-8b-a1b

Generated: 2026-09-30T06:45:23.873Z
Preflight exit code: 1
Source: 2dd1d94cbfc9ea2e4c0388f7d18e768a010355fec5c79260d9b7ddf1d47a5b93
Config: 94f416b0be98e6dabb2a40a4c9915c8d0e410c093d255cefdbb115948c714049

| Case | Task / stage | Input | Completed | Mechanical result | Median time / tokens | Semantic review |
|---|---|---|---:|---|---:|---|
| I01 | oversize / intent | available | 0/1 | 0 run findings | t=—, tokens=— | not assessed |
| I02 | contradiction / intent | available | 0/1 | 0 run findings | t=—, tokens=— | not assessed |
| E01 | rename-field / explore | missing-snapshot | 0/1 | 0 run findings | t=—, tokens=— | not assessed |
| E02 | multi-file-cascade / explore | missing-snapshot | 0/1 | 0 run findings | t=—, tokens=— | not assessed |
| A01 | two-right-answers / ask | missing-snapshot | 0/1 | 0 run findings | t=—, tokens=— | not assessed |
| A02 | impossible-without-data / ask | missing-snapshot | 0/1 | 0 run findings | t=—, tokens=— | not assessed |
| P01 | config-default / plan | missing-snapshot | 0/1 | 0 run findings | t=—, tokens=— | not assessed |
| P02 | migration-compat / plan | missing-snapshot | 0/1 | 0 run findings | t=—, tokens=— | not assessed |
| C01 | vat-rounding / chunk | available | 0/1 | 0 run findings | t=—, tokens=— | not assessed |
| C02 | rename-field / chunk | available | 0/1 | 0 run findings | t=—, tokens=— | not assessed |
| V00 | oversize / verify | available | 0/1 | 0/0 caught | t=—, tokens=— | not assessed |
| V01 | oversize / verify | available | 0/1 | 0/0 caught | t=—, tokens=— | not assessed |
| V02 | oversize / verify | available | 0/1 | 0/0 caught | t=—, tokens=— | not assessed |
| H01 | oversize / handoff | missing-snapshot | 0/1 | 0 run findings | t=—, tokens=— | not assessed |
| H02 | oversize / handoff | missing-snapshot | 0/1 | 0 run findings | t=—, tokens=— | not assessed |

## Known problem coverage

| Problem | Cases | Available inputs | Status |
|---:|---|---:|---|
| 1 | C01, C02 | 2/2 | inputs available |
| 2 | C01, C02 | 2/2 | inputs available |
| 3 | C01, C02 | 2/2 | inputs available |
| 4 | E01, E02 | 0/2 | partial or unavailable inputs |
| 5 | I01 | 1/1 | inputs available |
| 6 | P01, P02 | 0/2 | partial or unavailable inputs |
| 7 | I01, I02, C01 | 3/3 | inputs available |
| 8 | C01, C02 | 2/2 | inputs available |
| 9 | A01, A02 | 0/2 | partial or unavailable inputs |
| 10 | E01 | 0/1 | partial or unavailable inputs |
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
