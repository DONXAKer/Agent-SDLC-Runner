# Workspace notes

## Task-independent implementation

- Production code, model prompts, harness policies, schemas, validators and recovery logic must be independent of the current task, benchmark case and model response.
- Derive allowed paths, symbols, operations, requirements and expected behaviour from explicit task input, repository evidence and general protocol contracts. Do not embed benchmark names, fixture paths, task-specific identifiers, exact requirement phrases or expected answers in runtime branches or prompt examples.
- Fix failures at the general interface or invariant that caused them. Do not add special cases to make a particular task or model pass, and do not relax checks or change expected results to fit generated output.
- Keep task-specific data in test fixtures, benchmark definitions and reports. Use neutral examples in production prompts.
- Verify generality with unrelated task types and different paths, symbols and request wording, including unsupported or ambiguous inputs. Unknown semantics must remain explicit; never infer success from a task-specific shortcut.
- Before completing a change, inspect production code and prompts for accidental task coupling. Report remaining language or toolchain limits honestly; abstraction does not mean silently claiming support for every language or task.

## Local model endpoints

- LM Studio's local server currently listens on port `1434` on this machine (`lms server status`, checked 2026-10-02). Use `http://localhost:1434/v1` for its OpenAI-compatible API. The port may change; verify with `lms server status` before a run and override it with `LMSTUDIO_BASE_URL` when needed.
- Ollama was updated to `0.35.0` on 2026-10-02. This version is required for the Nimble `/v1/systemone` endpoint.
- Nimble 9B is installed locally. Its `/v1/systemone` endpoint worked after unloading Gemma from LM Studio to free shared resources. On a scope-violation smoke case, a detailed choice question returned the wrong `respects` answer with probability 0.885; a short literal yes/no version correctly returned 0.995. Keep Nimble in shadow/advisory use until a task-specific holdout establishes reliability.
