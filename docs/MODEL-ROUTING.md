# Local model routing

BORG separates planning inference from implementation inference while keeping all workflow authority, tools, and side effects in the server.

- `BORG_MODEL` selects the default implementation model. The default remains `qwen3-coder:30b`.
- `BORG_REASONING_MODEL` selects the complex-work architect model. The default is `devstral-small-2:latest`.
- An explicit `.localcode/team.json` discipline or architect role model remains the highest-priority architect selection.

The deterministic reasoning router bypasses the reasoning model for ASK requests and bounded single-file quick edits. It selects the reasoning model for structural or global changes, backend work, plan revisions, ambiguous intent, multi-file scope, and implementation requests without a safe deterministic plan.

Every decision is emitted as `model.routing.decided` and persisted as `MODEL_ROUTING_DECIDED`, including the reason and the architect and implementer model names. The architect keeps read-only planning permissions. Approval is still required before the implementer can mutate an isolated worktree.
