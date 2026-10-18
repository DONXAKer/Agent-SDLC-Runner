# Model diagnostics: ollama:gemma4-12b-compactfill

Generated: 2026-09-30T21:14:32.316Z
Preflight exit code: 0
Source: 04dade6d8967d378cfa248a2d8e254a099e091c05a478120446bb21b3b76d938
Config: 2ef53b224030cfe1ab92a2d04da6284933043f3f432a390a9da2bf7b48c15fb2

| Case | Task / stage | Input | Started | Mechanical result | Median time / tokens | Semantic review |
|---|---|---|---:|---|---:|---|
| I01 | oversize / intent | available | 1/1 | 0 run findings; completed | t=34s, tokens=19295 | not assessed |
| I02 | contradiction / intent | available | 1/1 | 0 run findings; completed | t=31s, tokens=17552 | not assessed |
| E01 | rename-field / explore | available | 1/1 | 0 run findings; completed | t=105s, tokens=100712 | not assessed |
| E02 | multi-file-cascade / explore | available | 1/1 | 0 run findings; completed | t=109s, tokens=128807 | not assessed |
| A01 | two-right-answers / ask | available | 0/1 | 1 run findings; INPUT_BLOCKED | t=1s, tokens=0 | not assessed |
| A02 | impossible-without-data / ask | available | 0/1 | 1 run findings; INPUT_BLOCKED | t=1s, tokens=0 | not assessed |
| P01 | config-default / plan | available | 1/1 | 0 run findings; completed | t=102s, tokens=176578 | not assessed |
| P02 | migration-compat / plan | available | 1/1 | 0 run findings; completed | t=105s, tokens=182010 | not assessed |
| C01 | vat-rounding / chunk | available | 1/1 | 1 run findings; HIDDEN_TEST_FAILED | t=108s, tokens=49203 | not assessed |
| C02 | rename-field / chunk | available | 1/1 | 0 run findings; completed | t=99s, tokens=56643 | not assessed |
| V00 | oversize / verify | available | 1/1 | 0/1 caught; STAGE_FAILED | t=140s, tokens=313426 | not assessed |
| V01 | oversize / verify | available | 1/1 | 1/1 caught; completed | t=170s, tokens=446616 | not assessed |
| V02 | oversize / verify | available | 1/1 | 0/1 caught; STAGE_FAILED, SEED_MISSED | t=160s, tokens=403560 | not assessed |
| H01 | oversize / handoff | available | 1/1 | 0 run findings; completed | t=171s, tokens=586491 | not assessed |
| H02 | oversize / handoff | available | 0/1 | 0 run findings; completed | t=1s, tokens=0 | not assessed |

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

- Разобрать отчёты провалившихся кейсов; менять один параметр за сравнительный запуск.
- Для verify проверить обзор diff, передачу посева и инструкции reviewer; сверить находку с чистым контролем V00.
- Смысловая оценка не выполнена: проверить артефакты по чеклистам кейсов перед выводом о качестве.

Semantic quality must be reviewed against each case rubric; completion and runtime gates do not establish correctness.
