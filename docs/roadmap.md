# Roadmap

## Alpha 0.1 — foundation

- [x] pnpm TypeScript monorepo
- [x] shared task/event contracts
- [x] Ollama model adapter
- [x] OpenCode runtime boundary
- [x] repository read/write/search/Git primitives
- [x] verification runner
- [x] SQLite task/event persistence
- [x] minimal local server and Codex-style task UI
- [ ] approval protocol for ASK / EDIT / AGENT
- [ ] patch/diff review UI
- [ ] terminal tool streaming
- [ ] repository indexing and `.localcode/` memory
- [ ] orchestrated inspect → plan → modify → verify loop

## Alpha 0.2 — coding agent

- planner / implementer / reviewer / verifier roles
- symbol-aware search and language-server integration
- checkpoints and undo
- persistent project instructions from `AGENTS.md`
- context ranking instead of whole-repository prompting

## Later

- desktop wrapper
- sandboxed command execution
- multiple local model profiles
- vision model support
- optional cloud-model escalation
