# BORG Code Alpha 0.3

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
- Permissioned tool broker with public-web page fetching, Ollama web search, private-network blocking, bounded redirects, and bounded tool rounds, calls, output, and repetition.
- Long-task defaults allow 30 tool rounds, 60 calls, 240,000 characters of evidence, 15-minute commands and verification, and a 10-minute fresh review; environment overrides remain hard-capped.
- Tool settings UI with an internet toggle and memory-only Ollama API credential handling.
- Live tool-start, result, failure, planning, and source activity in the task transcript and persistent event log.
- Permission-mode enforcement for ASK, PLAN, EDIT, and AGENT. Repository inspection is unavailable in ASK; mutating tools activate only after approval creates an isolated worktree.
- Brokered repository list, read, and literal-search tools constrained to the approved repository, with traversal, symlink escape, excluded-directory, secret-name, file-size, and result-count protections.
- Concrete OpenCode SDK client transport for an existing loopback OpenCode server. It normalizes text, tool, completion, failure, and cancellation events behind `AgentRuntime`; OpenCode-native mutation tools are disabled in this slice.
- Durable approval records linked one-to-one with tasks, including decision time, isolated worktree path, and immutable base commit.
- EDIT and AGENT tasks now pause in `AWAITING_APPROVAL` after planning. The workspace presents explicit Approve and Reject controls and restores pending approval state after a page reload.
- Approved plans create a task-scoped detached Git worktree under `.borg/worktrees`. The approved directory must be the repository root, the task ID is validated before path construction, and worktree creation is recorded in the append-only event log.
- Approved EDIT and AGENT tasks resume through a dedicated implementation stream after the plan approval response.
- Worktree read and exact-text patch tools revalidate the durable approval record on every call, reject traversal and link escapes, cap file sizes, and write atomically.
- Bounded command execution uses an executable allowlist, argument and output limits, per-command timeouts, no shell interpolation, and a worktree-scoped working directory.
- Git status and diff tools are constrained to the task's recorded worktree and return bounded output for review.
- Deterministic quick and full verification profiles are detected from Node, Python, Cargo, and Go project markers. The server always runs the quick profile before review and completion.
- Successful implementation transitions through IMPLEMENTING, VERIFYING, REVIEWING, DELIVERY_READY, DELIVERING, and COMPLETE; exhausted failures remain isolated and become BLOCKED.
- The workspace shows live patch, command, Git, verification, and final worktree-summary events.
- Failed deterministic verification schedules at most two evidence-driven repair attempts before the task becomes blocked.
- Successful verification is followed by a fresh-context review that receives only the original request, verified diff, and verification evidence; structured findings are persisted per task.
- High and critical review findings enter the same bounded repair loop.
- Passing tasks stop in `DELIVERY_READY` until the operator explicitly exports a complete binary-capable patch or creates a detached worktree commit.
- Delivery never mutates the user's primary checkout; exported patches live under `.borg/deliveries`, and commits remain in the isolated worktree for deliberate integration.

## Next vertical slice

Add browser-driven verification with DOM, console, network, screenshot, responsive, accessibility, and optional vision-model evidence.
