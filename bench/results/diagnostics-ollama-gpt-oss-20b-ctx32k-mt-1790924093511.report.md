# Model diagnostics: ollama:gpt-oss-20b-ctx32k-mt

Generated: 2026-10-02T06:54:53.509Z
Preflight exit code: 0
Source: af91642a7f3ab5b2f85c42dcbd40bb4c5bae64443b6810dc2a42ad2147223b4d
Config: 2ef53b224030cfe1ab92a2d04da6284933043f3f432a390a9da2bf7b48c15fb2

| Case | Task / stage | Input | Started | Mechanical result | Median time / tokens | Semantic review |
|---|---|---|---:|---|---:|---|
| I01 | oversize / intent | available | 1/1 | 0 run findings; completed | t=148s, tokens=110195 | not assessed |

## Known problem coverage

| Problem | Cases | Available inputs | Status |
|---:|---|---:|---|
| 1 | — | 0/0 | unmapped |
| 2 | — | 0/0 | unmapped |
| 3 | — | 0/0 | unmapped |
| 4 | — | 0/0 | unmapped |
| 5 | I01 | 1/1 | inputs available |
| 6 | — | 0/0 | unmapped |
| 7 | I01 | 1/1 | inputs available |
| 8 | — | 0/0 | unmapped |
| 9 | — | 0/0 | unmapped |
| 10 | — | 0/0 | unmapped |
| 11 | — | 0/0 | unmapped |
| 12 | — | 0/0 | unmapped |
| 13 | — | 0/0 | unmapped |
| 14 | I01 | 1/1 | inputs available |
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

- Смысловая оценка не выполнена: проверить артефакты по чеклистам кейсов перед выводом о качестве.

Semantic quality must be reviewed against each case rubric; completion and runtime gates do not establish correctness.
