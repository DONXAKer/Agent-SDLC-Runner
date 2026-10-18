# Model diagnostics: ollama:gpt-oss-20b-compactfill

Generated: 2026-10-09T11:20:16.817Z
Preflight exit code: 0
Source: e98ea04d65f97c8c4a4069a502635afbba08d2b18a54ab29dfd171b714b30c3c
Config: 943c7c8eab76d50eea02d5a63230a4a4402ebc8b404745538c8cc547514ef64f

| Case | Task / stage | Input | Started | Mechanical result | Median time / tokens | Semantic review |
|---|---|---|---:|---|---:|---|
| I01 | oversize / intent | available | 5/5 | 5 run findings; UNFILLED | t=101s, tokens=37076 | not assessed |
| I02 | contradiction / intent | available | 5/5 | 5 run findings; UNFILLED | t=88s, tokens=30959 | not assessed |
| E01 | rename-field / explore | available | 5/5 | 5 run findings; TIMEOUT, UNFILLED | t=121s, tokens=31567 | not assessed |
| E02 | multi-file-cascade / explore | available | 5/5 | 5 run findings; TIMEOUT, UNFILLED | t=121s, tokens=55911 | not assessed |
| A01 | two-right-answers / ask | available | 0/5 | 0 run findings; completed | t=1s, tokens=0 | not assessed |
| A02 | impossible-without-data / ask | available | 5/5 | 5 run findings; TIMEOUT | t=121s, tokens=52608 | not assessed |
| P01 | config-default / plan | available | 5/5 | 5 run findings; TIMEOUT, UNFILLED | t=121s, tokens=79510 | not assessed |
| P02 | migration-compat / plan | available | 5/5 | 5 run findings; TIMEOUT, UNFILLED | t=121s, tokens=89661 | not assessed |
| C01 | vat-rounding / chunk | available | 5/5 | 5 run findings; TIMEOUT, HIDDEN_TEST_FAILED | t=121s, tokens=24231 | not assessed |
| C02 | rename-field / chunk | available | 5/5 | 5 run findings; TIMEOUT, HIDDEN_TEST_FAILED | t=121s, tokens=29874 | not assessed |
| V00 | oversize / verify | available | 5/5 | 0/5 caught; TIMEOUT, UNFILLED, HANDOFF_INPUT_INCOMPLETE | t=121s, tokens=141519 | not assessed |
| V01 | oversize / verify | available | 5/5 | 0/5 caught; TIMEOUT, UNFILLED, SEED_MISSED, HANDOFF_INPUT_INCOMPLETE | t=121s, tokens=200010 | not assessed |
| V02 | oversize / verify | available | 5/5 | 0/5 caught; TIMEOUT, UNFILLED, SEED_MISSED, HANDOFF_INPUT_INCOMPLETE | t=121s, tokens=156242 | not assessed |
| H01 | oversize / handoff | available | 5/5 | 5 run findings; TIMEOUT, UNFILLED | t=121s, tokens=289246 | not assessed |
| H02 | oversize / handoff | available | 0/5 | 0 run findings; completed | t=1s, tokens=0 | not assessed |

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

- Проверить лимит времени на этапах с timeout; сравнить с более высоким лимитом на том же кейсе.
- Разобрать отчёты провалившихся кейсов; менять один параметр за сравнительный запуск.
- Для verify проверить обзор diff, передачу посева и инструкции reviewer; сверить находку с чистым контролем V00.
- Смысловая оценка не выполнена: проверить артефакты по чеклистам кейсов перед выводом о качестве.

Semantic quality must be reviewed against each case rubric; completion and runtime gates do not establish correctness.
