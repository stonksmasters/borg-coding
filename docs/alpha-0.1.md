# BORG Code Alpha 0.1

## Implemented foundation

- Typed and runtime-validated Task, Finding, and TaskEvent contracts.
- Explicit task-state transition rules, including repair loops.
- SQLite task repository with append-only event storage.
- AgentRuntime boundary and an OpenCode adapter over an injectable client.
- Local HTTP server with health, create-task, and list-task endpoints.
- First BORG workspace UI with project, task progress, activity, permissions mode, runtime, and verification status.
- Task composer wired to the local API; submitted tasks are stored in SQLite and become the active workspace task.
- Live newline-delimited event stream for chat and task updates. All stages start pending and advance only from received task-state events.
- Truthful runtime-waiting state when no local model transport is connected.
- Direct Ollama chat transport using `qwen3-coder:30b`, with token-by-token response streaming and runtime health/model detection.
- Explicit repository and document access policy, persisted locally and enforced by the backend context assembler.
- Bounded repository mapping with dependency, build, Git, agent-metadata, and secret-like files excluded.
- Permissioned tool broker with public-web page fetching, Ollama web search, private-network blocking, bounded redirects, and a five-round tool-loop limit.
- Tool settings UI with an internet toggle and memory-only Ollama API credential handling.
- Live tool-start, result, failure, planning, and source activity in the task transcript and persistent event log.
- Permission-mode enforcement for ASK, PLAN, EDIT, and AGENT. Repository inspection is unavailable in ASK; mutating tools remain disabled until worktree isolation lands.
- Brokered repository list, read, and literal-search tools constrained to the approved repository, with traversal, symlink escape, excluded-directory, secret-name, file-size, and result-count protections.
- Concrete OpenCode SDK client transport for an existing loopback OpenCode server. It normalizes text, tool, completion, failure, and cancellation events behind `AgentRuntime`; OpenCode-native mutation tools are disabled in this slice.
- Durable approval records linked one-to-one with tasks, including decision time, isolated worktree path, and immutable base commit.
- EDIT and AGENT tasks now pause in `AWAITING_APPROVAL` after planning. The workspace presents explicit Approve and Reject controls and restores pending approval state after a page reload.
- Approved plans create a task-scoped detached Git worktree under `.borg/worktrees`. The approved directory must be the repository root, the task ID is validated before path construction, and worktree creation is recorded in the append-only event log.

## Next vertical slice

Add worktree-scoped patching, bounded command execution, Git status/diff tools, and verification profiles. Every mutation must require an approved task and resolve inside that task's recorded worktree.
