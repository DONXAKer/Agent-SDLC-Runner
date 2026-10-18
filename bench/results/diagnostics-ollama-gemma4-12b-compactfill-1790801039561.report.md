# Model diagnostics: ollama:gemma4-12b-compactfill

Generated: 2026-09-30T20:43:59.560Z
Preflight exit code: 0
Source: 81a7068962bb6565d672426ab610be2ac07689230272c4c456fcf03bc0ddab82
Config: 2ef53b224030cfe1ab92a2d04da6284933043f3f432a390a9da2bf7b48c15fb2

| Case | Task / stage | Input | Started | Mechanical result | Median time / tokens | Semantic review |
|---|---|---|---:|---|---:|---|
| H01 | oversize / handoff | available | 1/1 | 1 run findings; STAGE_FAILED | t=147s, tokens=507458 | not assessed |

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
| 21 | — | 0/0 | unmapped |
| 22 | — | 0/0 | unmapped |
| 23 | — | 0/0 | outside model diagnosis |
| 24 | — | 0/0 | outside model diagnosis |
| 25 | — | 0/0 | unmapped |
| 26 | — | 0/0 | unmapped |

## Suggestions

- Разобрать отчёты провалившихся кейсов; менять один параметр за сравнительный запуск.
- Смысловая оценка не выполнена: проверить артефакты по чеклистам кейсов перед выводом о качестве.

Semantic quality must be reviewed against each case rubric; completion and runtime gates do not establish correctness.
