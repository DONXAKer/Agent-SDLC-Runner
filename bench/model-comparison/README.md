# Local model comparison

This experiment leaves production profiles unchanged. The previous guided pilot is
not resumed. Model names, task cases and expected answers live only in this benchmark.

Prepare weights (about 83 GB, plus temporary package caches) outside the GPU budget:

```powershell
node bench/model-comparison/prepare.mjs .tmp/model-comparison-20261019 --download
node bench/model-comparison/prepare.mjs .tmp/model-comparison-20261019 --verify
node bench/model-comparison/capture-control.mjs
curl.exe -fsSL https://github.com/astral-sh/uv/releases/download/0.11.2/uv-x86_64-unknown-linux-gnu.tar.gz -o .tmp/model-comparison-20261019/uv-linux.tar.gz
wsl -d Ubuntu -- tar -xzf .tmp/model-comparison-20261019/uv-linux.tar.gz -C .tmp/model-comparison-20261019
wsl -d Ubuntu -- bash bench/model-comparison/setup-wsl.sh
wsl -d Ubuntu -- bash bench/model-comparison/setup-standard.sh
wsl -d Ubuntu -- bash bench/model-comparison/setup-adapter.sh
wsl -d Ubuntu -- bash bench/model-comparison/capture-environments.sh
```

`prepare.mjs` pins Hub revisions and validates downloaded LFS SHA-256 and lengths.
NeoHorse Q6_K is packaged by mradermacher, rather than TokenRhythm. The selected
quantization is recorded explicitly; missing formats are never silently substituted.
StandardOne uses the author's v2.2 tag, SGLang and decision adapter. Intern-Decision
and Nimble v2 use their published inference code, without adapting weights or heads.
Nimble's pinned base is mapped into an offline Hub snapshot; its prompt files and
calibration remain unchanged. Python environments are isolated under
`/var/tmp/sdlc-model-comparison-20261019` on WSL's Linux disk, avoiding slow CUDA package
writes and library reads over DrvFS. `runtime.json` records the paths used. Existing
workspace environments can be copied with `stage-native.sh`; weights stay in `.tmp`.
Run environment setup commands sequentially so their runtime manifest updates do not
race. The Linux uv binary is unpacked into `.tmp/model-comparison-20261019` from the
official `astral-sh/uv` 0.11.2 Linux archive before these setup commands.

The comparison runs its own Ollama server at port 11435, with the existing model
store, one loaded model and one concurrent request. It creates only `comparison-*`
model tags. Unload models from other inference servers before starting. The benchmark
records actual GPU placement and rejects CPU offload from executor eligibility.

```powershell
node --test bench/test/modelComparison.test.mjs
node bench/model-comparison/run.mjs .tmp/comparison-dry-run --dry-run
node bench/model-comparison/run.mjs bench/results/<new-series>
```

The three-hour timer starts with `run.mjs`, after downloads and installation. Screening
requires at least 10,500/6,500 MiB free on the 12/8 GiB cards and utilization at most
10%/25% at startup for three consecutive samples; the 4060 drives the desktop.
Busy GPUs are rejected before the timer starts. These are this local
experiment's readiness limits, not a general production scheduling policy. Screening
is bounded by minute 90, full cycles by minute 150, and holdout/rechecks by minute 180.
Stop with Ctrl+C: child processes are stopped and partial observations remain partial.
There is no automatic resume into a changed series. Each experiment uses a new directory.

Executor screening uses the existing `PREFLIGHT_CASES` through the actual provider.
The installed Qwen tag's `<think>` stop is recorded explicitly. An additional control
compares its original tag with a copy removing only the incompatible thinking stops;
reasoning and KV-cache comparisons then use that same compatible tag. All executor
variants use explicit temperature 0.15, matching the original control, rather than
silently inheriting different sampling defaults. This is not a per-model optimum.
Only fully GPU-resident candidates passing all cases are eligible for full guided
v4/prep3 cycles. Two winners each receive add-validator and rename-field, with strict
questions, three repair attempts and at most fifteen minutes per cycle. This is a
screening study, not the prior full pilot or its matrix/transfer gate.

Decision models receive 30 diagnostic questions. The best completed model receives
the separate 30-question holdout. Six families cover scope, grounded claims, human
clarification, contradictory contracts, tool suitability and unknown policy. Gold
labels, family labels, split names and grading metadata are not model inputs.
Probabilities must be finite and in [0,1]. Invalid responses are never permissions.
Report scope violations separately from unsupported claims, accuracy and calibration.
No threshold or temperature is fitted against these cases. Two diagnostic items are
also asked as choices in both option orders; unsupported response formats are marked
explicitly. These checks do not establish general order or paraphrase robustness.

The handwritten set is small and imperfect; public author results do not establish
our hardware's latency or our task accuracy. A valid API response is not evidence of
correctness. Independent tests and production policy remain authoritative.

Follow-up runs can use `--judges-only --judge-ids=standard3 --diagnostic-only`
with `--deadline=<ISO timestamp>` to preserve the original study deadline.
`--holdout-only` requires exactly one selected judge; reusing an already observed
holdout is a repeat measurement, not new independent validation.
The physical decision GPU is selected by UUID and maximum memory, because CUDA
and nvidia-smi can enumerate the cards differently.

On this WSL installation SGLang's default CUDA-JIT kernels conflict with glibc
2.43 headers. `--standard-backend=torch` explicitly selects SGLang's supported
PyTorch fused-op backend; report this as a distinct runtime configuration.
CUDA nvcc, CRT and NVVM are pinned together at 13.0.88 in setup-standard.sh.
The setup also creates linker aliases for the runtime and WSL driver libraries.
Prefer fresh installation directly on the Linux filesystem: copying a venv from
DrvFS can lose executable modes, including nested compiler tools.

SGLang, its adapter and the local HTTP worker communicate on WSL localhost;
Windows exchanges JSONL with that worker. This avoids depending on Windows/WSL
localhost forwarding or exposing model servers on external interfaces.
The optional no-GPU integration check is:

```powershell
$env:SDLC_TEST_WSL = '1'
node --test bench/test/modelComparison.test.mjs bench/test/modelComparisonWsl.test.mjs
```
