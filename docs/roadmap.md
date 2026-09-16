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
- [x] approval protocol for ASK / EDIT / AGENT
- [x] first inspect → tool → result → final orchestration loop
- [x] approval cards and live tool activity in the UI
- [x] workspace selection with recent repositories
- [x] repository indexing cached in `.localcode/index.json`
- [x] AGENTS.md / docs / project metadata discovery
- [x] task-ranked source context instead of whole-repository prompting
- [x] live command and verification output streaming
- [x] working-tree diff review panel
- [x] automatic pre-edit checkpoints and task-level undo
- [x] task-relative review baselines that preserve pre-existing local edits
- [x] per-file accept and reject controls
- [x] per-hunk accept and reject controls
- [x] accept-all / reject-all review controls without staging or committing
- [ ] symbol-aware retrieval and language-server integration

## Alpha 0.2 — coding agent

- planner / implementer / reviewer / verifier roles
- symbol-aware search and language-server integration
- checkpoint history browser and named checkpoints
- persistent project memory beyond structural indexing
- review decision history and review-session persistence across task continuations

## Later

- desktop wrapper with native folder picker
- sandboxed command execution
- multiple local model profiles
- vision model support
- optional cloud-model escalation
