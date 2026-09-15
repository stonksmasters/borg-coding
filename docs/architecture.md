# Architecture

BORG Coding is split into five layers:

1. **Workspace UI** — task threads, model/runtime status, permission mode, diffs, terminal and verification output.
2. **Agent server** — owns sessions, event streaming, orchestration and permission enforcement.
3. **Tool layer** — repository reads/writes, ripgrep, Git, shell and verification.
4. **Runtime/model adapters** — Ollama and OpenCode are initial implementations, not permanent dependencies.
5. **Persistence/context** — SQLite task history plus `.localcode/` repository memory.

The event stream is the contract between server and UI. A task emits lifecycle events such as `task.started`, `model.token`, `tool.started`, `tool.completed`, `verification.completed`, `task.completed`, and `task.failed`.

## Permission modes

- **ASK** — reading is automatic; edits and commands require approval.
- **EDIT** — file edits are allowed; risky commands still require approval.
- **AGENT** — BORG can edit and execute within the configured workspace policy.

Permission checks belong in orchestration/tool execution, never in the frontend alone.
