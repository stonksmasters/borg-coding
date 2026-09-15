# BORG Coding

BORG Coding is a local-first, Codex-style software engineering environment built around replaceable local models and inspectable developer tools.

The model is only one layer. BORG owns repository context, permissions, tool execution, verification, task state, and the developer UI.

## Architecture

- `apps/web` — React/Vite Codex-style workspace
- `apps/server` — local Node/TypeScript agent server
- `packages/core` — shared contracts and event types
- `packages/models` — local model adapters (Ollama first)
- `packages/runtime-opencode` — OpenCode runtime boundary
- `packages/repository` — repo-aware filesystem/search/git tools
- `packages/verification` — lint/typecheck/test/build verification
- `packages/persistence` — SQLite task/session persistence

## Local stack

- Node.js + TypeScript
- pnpm workspaces
- React + Vite
- Ollama
- `qwen3-coder:30b` as the initial coding model
- OpenCode as the first external coding runtime
- SQLite for local state
- WebSocket event streaming
- Zod contracts

## Getting started

```bash
pnpm install
ollama pull qwen3-coder:30b
pnpm dev
```

The server defaults to `http://127.0.0.1:8787` and the web app to `http://127.0.0.1:5173`.

## Product principles

1. Local-first by default.
2. Models are replaceable engines, not the product.
3. Repository edits and shell execution are explicit tools.
4. ASK / EDIT / AGENT permission modes are first-class.
5. Every implementation loop ends in verification.
6. BORG keeps durable project memory in `.localcode/` and SQLite rather than stuffing the whole repository into every prompt.
