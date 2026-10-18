# Model diagnostics: ollama:gpt-oss-20b-compactfill

Generated: 2026-10-09T15:31:41.054Z
Preflight exit code: 0
Source: ae801a0ce16331767d1cbf1d97d1e92be3a89b3315b315012556f60f4a8b4789
Config: df16bc81e5d656e2686efe9fdec267e5c615a1ab0db23f7cf67a89130ccda6b7

| Case | Task / stage | Input | Started | Mechanical result | Median time / tokens | Semantic review |
|---|---|---|---:|---|---:|---|
| I01 | oversize / intent | available | 1/1 | 1 run findings; INCOMPLETE, UNFILLED | t=70s, tokens=32045 | not assessed |

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
