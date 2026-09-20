# BORG Debug v1

## Purpose

Debug v1 exists to answer one question when BORG behaves unexpectedly:

> What durable state is BORG in, what happened immediately before it, and what evidence explains why it did or did not continue?

Debugging is observational. It does not own workflow state and it does not repair, retry, approve, execute commands, or mutate repositories.

## Authority

Debug v1 reads existing authorities only:

- SQLite task and workflow records;
- `WorkflowEngine` state;
- approvals;
- verification and recovery gates;
- persisted checkpoints and continuations;
- canonical workflow events;
- persisted ContextPacks and model-context metadata;
- managed process state;
- Git/worktree state;
- durable review history.

There is no debug database and no debug state machine.

## DebugSnapshot v1

`GET /api/control/tasks/:taskId/snapshot` returns a versioned, sanitized, read-only snapshot.

The snapshot includes:

- task identity/state/attempt;
- workflow phase, loop, version, current slice, next action, and pending command;
- approval;
- verification gate;
- recovery descriptor;
- canonical event history;
- ContextPack summaries and exact manifest paths/reasons;
- model request metadata and context fingerprints;
- managed process state and bounded stdout/stderr;
- repository/worktree/base/HEAD/status;
- checkpoints and continuations;
- role assignments and handoffs;
- review runs/findings;
- invariant diagnostics.

Raw model input and environment values are intentionally excluded.

## Live debug stream

`GET /api/control/tasks/:taskId/stream` is an SSE stream of sanitized canonical workflow events.

The desktop Debug workspace uses this stream only while the Debug view is open. Events trigger a fresh snapshot read so the UI remains a projection of durable state rather than creating a second live-state authority.

## Export

`GET /api/control/tasks/:taskId/export` returns a portable `borg-debug-json` bundle.

The desktop **Export** action downloads this bundle so a failed run can be inspected without manually copying logs from multiple surfaces.

## Redaction

Debug output recursively redacts sensitive field names such as authorization, credentials, passwords, secrets, tokens, API keys, and private keys. It also scrubs common bearer tokens, JWTs, OpenAI/GitHub-style token formats, and credential-like query parameters.

Environment values and raw model prompts are excluded from DebugSnapshot v1.

Managed process output is already bounded and receives the process runtime's configured secret redaction before Debug reads it.

## Invariant diagnostics

Debug v1 reports contradictions and suspicious state without mutating anything.

Current checks include:

- task/workflow ownership mismatch;
- recovery-required task without a durable recovery descriptor;
- awaiting-approval task without a requested approval;
- review/delivery state without passed current verification;
- verification from a different repair attempt;
- approved worktree missing;
- approved base commit no longer an ancestor of worktree HEAD;
- pending workflow command claimed by the wrong task;
- pending workflow command remaining unclaimed for 30 seconds;
- ContextPack from a future workflow version;
- potentially stale scoped ContextPack during execution;
- scoped ContextPack with unusually broad manifest;
- ContextPack using at least 95% of its character budget;
- multiple simultaneously active engineering roles;
- active mutation/quality-gate state with no managed process or persisted activity for five minutes;
- failed managed process while a quality gate is active.

Warnings are diagnostic evidence, not workflow authority. They never change the task.

## Desktop workflow

Open **Debug** from the main workspace tabs or Advanced menu.

The Debug workspace shows:

1. task/workflow/slice/next action;
2. verification, recovery, approval, and runtime;
3. pending command identity and claim state;
4. invariant diagnostics;
5. repository/worktree state;
6. current ContextPack and included manifest;
7. recorded model requests;
8. managed processes and bounded logs;
9. canonical event timeline;
10. raw sanitized snapshot.

## Completion criteria for Debug v1

Debug v1 is complete when:

- a healthy workflow produces no false critical invariant error;
- an intentionally inconsistent workflow produces the expected diagnostic;
- an unclaimed workflow command is visible and flagged;
- missing/diverged worktree evidence is visible;
- stale/broad context is visible;
- verification/recovery contradictions are visible;
- process failures are visible;
- exported bundles contain enough evidence to diagnose a stopped workflow;
- secrets/environment values/raw model prompts are not included;
- typecheck, lint, tests, production build, and Windows desktop lifecycle pass.

## Non-goals

Debug v1 does not include:

- remote control;
- SSH;
- phone/device pairing;
- push notifications;
- arbitrary shell execution from the debug API;
- retry/repair buttons that bypass normal workflow authority;
- a second persistence layer;
- private chain-of-thought.
