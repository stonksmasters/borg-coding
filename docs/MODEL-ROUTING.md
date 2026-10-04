# Local model routing

BORG separates planning inference from implementation inference while keeping all workflow authority, tools, and side effects in the server.

- `BORG_MODEL` selects the default implementation model. The default remains `qwen3-coder:30b`.
- `BORG_REASONING_MODEL` selects the complex-work architect model. The default is `devstral-small-2:latest`.
- An explicit `.localcode/team.json` discipline or architect role model remains the highest-priority architect selection.

The deterministic reasoning router bypasses the reasoning model for ASK requests and bounded single-file quick edits. It selects the reasoning model for structural or global changes, backend work, plan revisions, ambiguous intent, multi-file scope, and implementation requests without a safe deterministic plan.

Every decision is emitted as `model.routing.decided` and persisted as `MODEL_ROUTING_DECIDED`, including the reason and the architect and implementer model names. The architect keeps read-only planning permissions. Approval is still required before the implementer can mutate an isolated worktree.

Devstral requests use temperature `0.2`, a 16K runtime context, and a 2K maximum response. Tool-free planning turns can retry once after a transient streamed failure because they have no side effects. When Ollama terminates a planning turn at the response cap after returning substantial text, BORG preserves that bounded plan for its deterministic artifact normalizer. These provider bounds keep structured planning turns finite on the initial 8 GB GPU target while leaving Qwen execution settings unchanged.

For website blueprints, Devstral's frozen product map, design brief, and design system remain authoritative. BORG compiles these typed artifacts into the validated component and slice plan and records `BLUEPRINT_COMPLETION_COMPILED`. This avoids a redundant fourth long-form generation on the initial 8 GB GPU target. The same compiler also remains the fallback if another reasoning provider terminates during final blueprint synthesis.
