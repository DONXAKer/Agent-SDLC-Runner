# Workspace notes

## Local model endpoints

- LM Studio's local server currently listens on port `1434` on this machine (`lms server status`, checked 2026-10-02). Use `http://localhost:1434/v1` for its OpenAI-compatible API. The port may change; verify with `lms server status` before a run and override it with `LMSTUDIO_BASE_URL` when needed.
- Ollama was updated to `0.35.0` on 2026-10-02. This version is required for the Nimble `/v1/systemone` endpoint.
- Nimble 9B is installed locally. Its `/v1/systemone` endpoint worked after unloading Gemma from LM Studio to free shared resources. On a scope-violation smoke case, a detailed choice question returned the wrong `respects` answer with probability 0.885; a short literal yes/no version correctly returned 0.995. Keep Nimble in shadow/advisory use until a task-specific holdout establishes reliability.
