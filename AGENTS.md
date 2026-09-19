# BORG Coding agent instructions

BORG is a local-first coding agent, not a generic chatbot.

## Engineering rules

- Keep model providers replaceable behind adapters.
- Keep filesystem, shell, Git, and verification operations explicit and inspectable.
- Never hide a tool side effect inside a model adapter.
- Preserve ASK / PLAN / EDIT / AGENT permission semantics.
- Prefer small typed packages over a single backend blob.
- All repository paths must be constrained to the selected workspace root.
- Every implementation flow should be able to end with lint, typecheck, tests, and build verification.
- Durable repository knowledge belongs in `.localcode/` and SQLite; do not depend on giant prompts.
- Windows 11 is a first-class target.

## Initial local runtime

- Ollama
- `qwen3-coder:30b`
- Direct brokered Ollama runtime (`apps/server/src/ollama-agent.ts`)
