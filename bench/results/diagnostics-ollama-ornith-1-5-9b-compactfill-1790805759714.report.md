# Model diagnostics: ollama:ornith-1.5-9b-compactfill

Generated: 2026-09-30T22:02:39.713Z
Preflight exit code: 1
Preflight problem (model): модель: заполнение поля через Edit: вызван Read вместо Edit (провал в 2/2 попыток)
Preflight problem (model): модель: точный Edit многострочного блока: вызван Read вместо Edit (провал в 2/2 попыток)
Source: e60a07bf54017fcf3ac069e6ba78efe1439f08681b3192db91396d5b09d183da
Config: 2ef53b224030cfe1ab92a2d04da6284933043f3f432a390a9da2bf7b48c15fb2

| Case | Task / stage | Input | Started | Mechanical result | Median time / tokens | Semantic review |
|---|---|---|---:|---|---:|---|
| V00 | oversize / verify | available | 0/1 | 0/0 caught; available: oversize-axes3-diagnostic-v4 | t=—, tokens=— | not assessed |

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
| 21 | V00 | 1/1 | inputs available |
| 22 | V00 | 1/1 | inputs available |
| 23 | — | 0/0 | outside model diagnosis |
| 24 | — | 0/0 | outside model diagnosis |
| 25 | V00 | 1/1 | inputs available |
| 26 | — | 0/0 | unmapped |

## Suggestions

- Исправить среду или конфигурацию по preflight; результаты модельных кейсов не запускались.

Semantic quality must be reviewed against each case rubric; completion and runtime gates do not establish correctness.
