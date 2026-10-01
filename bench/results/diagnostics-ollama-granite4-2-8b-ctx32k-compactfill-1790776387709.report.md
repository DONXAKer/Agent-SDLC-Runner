# Model diagnostics: ollama:granite4.2-8b-ctx32k-compactfill

Generated: 2026-09-30T13:53:07.707Z
Preflight exit code: 0
Source: 082ee9343ba1c7324a10d75401198358ca8004fb86d957d30534fef795f1f7df
Config: deaf052d5a2169ceca80b51e5608c3e8d7361bb67d180a4e149035c809e8f4e5

| Case | Task / stage | Input | Started | Mechanical result | Median time / tokens | Semantic review |
|---|---|---|---:|---|---:|---|
| I01 | oversize / intent | available | 1/1 | 1 run findings; STAGE_FAILED | t=219s, tokens=139462 | not assessed |
| I02 | contradiction / intent | available | 1/1 | 1 run findings; STAGE_FAILED | t=358s, tokens=134532 | not assessed |
| E01 | rename-field / explore | available | 1/1 | 1 run findings; TIMEOUT | t=481s, tokens=72544 | not assessed |
| E02 | multi-file-cascade / explore | missing-snapshot | 0/1 | 0 run findings; missing-snapshot: no validated multi-file-cascade snapshot after intent | t=—, tokens=— | not assessed |
| A01 | two-right-answers / ask | missing-snapshot | 0/1 | 0 run findings; missing-snapshot: no validated two-right-answers snapshot after explore | t=—, tokens=— | not assessed |
| A02 | impossible-without-data / ask | missing-snapshot | 0/1 | 0 run findings; missing-snapshot: no validated impossible-without-data snapshot after explore | t=—, tokens=— | not assessed |
| P01 | config-default / plan | missing-snapshot | 0/1 | 0 run findings; missing-snapshot: no validated config-default snapshot after ask | t=—, tokens=— | not assessed |
| P02 | migration-compat / plan | missing-snapshot | 0/1 | 0 run findings; missing-snapshot: no validated migration-compat snapshot after ask | t=—, tokens=— | not assessed |
| C01 | vat-rounding / chunk | available | 1/1 | 1 run findings; HIDDEN_TEST_FAILED | t=216s, tokens=109326 | not assessed |
| C02 | rename-field / chunk | available | 1/1 | 1 run findings; TIMEOUT | t=481s, tokens=94367 | not assessed |
| V00 | oversize / verify | available | 1/1 | 0/1 caught; TIMEOUT | t=481s, tokens=198758 | not assessed |
| V01 | oversize / verify | available | 1/1 | 0/1 caught; TIMEOUT, SEED_MISSED | t=481s, tokens=266195 | not assessed |
| V02 | oversize / verify | available | 1/1 | 1/1 caught; TIMEOUT | t=481s, tokens=768761 | not assessed |
| H01 | oversize / handoff | missing-snapshot | 0/1 | 0 run findings; missing-snapshot: no validated oversize snapshot after verify | t=—, tokens=— | not assessed |
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

- Подготовить и проверить отсутствующие снимки, чтобы расширить покрытие известных проблем.
- Проверить лимит времени на этапах с timeout; сравнить с более высоким лимитом на том же кейсе.
- Разобрать отчёты провалившихся кейсов; менять один параметр за сравнительный запуск.
- Для verify проверить обзор diff, передачу посева и инструкции reviewer; сверить находку с чистым контролем V00.
- Смысловая оценка не выполнена: проверить артефакты по чеклистам кейсов перед выводом о качестве.

Semantic quality must be reviewed against each case rubric; completion and runtime gates do not establish correctness.
