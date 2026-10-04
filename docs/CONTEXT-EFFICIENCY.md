# Context efficiency implementation

## First stage: accounting and source preservation

Implementation turns preserve all system/user messages and tool exchange envelopes. Byte-identical repeated worktree observations are replaced with a shorter reference to the later observation in the same request. The second stage below adds durable references under pressure. The original history is not mutated.

The complete serialized request (including tool definitions and envelope) is checked against the configured character budget. After safe context rebuilding, a still-oversized implementation request stops with `context_capacity` rather than silently clipping requirements or source. Automatic decomposition of approved work into smaller tasks is not implemented. Implementation transport retries retain the same capacity budget.

This is a character guard, not a tokenizer or a guarantee that the request fits the model's token window. Existing planning compaction is unchanged.

`RUNTIME_CONTEXT_ACCOUNTED` records role sizes, tool schema size, envelope size, total characters, savings, phase, attempt and whether the request was accepted. `RUNTIME_INFERENCE_MEASURED` records Ollama's prompt/generated token counts and evaluation/load durations, plus observed first-response and elapsed times. Missing provider values remain null. Both events are persisted through the planning and execution event sinks.

`worktree_read_many` reads up to six related files within the existing approved worktree boundary, capped at 24000 serialized characters. Role/discipline and permission checks still apply. Reads include SHA-256 content hashes; this does not constitute a cache or authorize edits against stale contents. Single-file reads support inclusive 1-based line ranges while preserving line endings. Oversized tool output is explicitly labeled as an incomplete preview; full output remains in the tool completion event.

## Second stage: durable observations and context rebuilding

Successful worktree reads, batches, stats and lists are saved in SQLite's `tool_observations` table. Receipt metadata is recorded in task events; lookup uses observation ID and task ID without loading the entire event history. Records are immutable through this API and include a SHA-256 integrity hash.

When an implementation request exceeds its budget, older saved observations can be replaced with compact receipts. System/user messages, assistant messages, tool call/result envelopes, failures, mutation results, verification evidence and the two newest tool exchanges are retained. Missing durable records never qualify for removal. `RUNTIME_CONTEXT_REBUILT` records the size change. Receipt compaction is enabled only when the historical retrieval tool is available; tool-free final synthesis does not discard evidence it cannot retrieve.

`worktree_observation_read` returns bounded pages of the exact serialized historical output. It enforces existing worktree approval and role/permission boundaries, scopes lookup to the current task, and verifies the hash. Historical evidence is labeled explicitly: the model must read current source before patching. These hashes are integrity checks, not a cache freshness guarantee.

Execution/repair context packs retain complete required authority sections instead of applying the old per-section clipping. Packs now default to at most 24000 characters, with smaller project budgets supported. Required registry sections are allocated before optional design projections. Source over 10000 characters, or unable to fit inline, is represented by path/hash/size and a `worktree_read` instruction when the reference fits. Inline source preserves whitespace. These references continue to count as scoped source files for quick-edit boundaries.

Packs are recompiled and recorded on each implementation/repair attempt from the approved plan snapshot and current worktree files. Repair authority no longer uses an arbitrary 10000-character cut. This does not change approved task scope, re-plan the project, or weaken verification gates.

## Third stage: budget propagation and bounded progress

The benchmark sends its pack budget through website creation; the persisted project setting is passed to planning and execution compilers, including repair retries. This pack budget is separate from the complete serialized request budget (72000 by default), which also includes runtime instructions, schemas and history. A 24000-character pack leaves capacity for that overhead; exact total sizing is still checked before every inference.

Whole-file reads can carry a known SHA-256. The broker reads and hashes the current file before returning `notModified`. The runtime supplies this hash only for previously persisted source with an available retrieval tool, and returns its durable receipt when unchanged. Writes, patches and commands invalidate runtime reuse. Line-range reads always return exact source. Repeated identical calls/unchanged reads hand control back after the current tool exchange, without another synthesis inference. Repair, verification and review permissions include the bounded read/retrieval tools.

Compiler repairs are partitioned into work units covering at most two implicated source files and their inferred missing dependencies. All diagnostics remain assigned; each unit progresses only after a source change. Full verification follows the units. No-mutation attempts bypass budget continuations and go directly to verification. Repeated identical source fingerprints and verification failures stop further identical repairs; changed source or changed failure evidence permits another attempt within the existing repair limit.

Context capacity reached after tool work also hands control back for a bounded continuation or verification. The original approved scope and quality checks still apply. Initial protected authority that cannot fit still blocks explicitly; arbitrary decomposition of oversized product requirements is not implemented.

Verification summaries lead with failed commands and their stdout/stderr. Benchmark `verification.json` includes command arguments, exit codes, timeout flags, and complete captured command output, so missing browser evidence cannot obscure a compiler error.

## Benchmark evaluation

Compare repeated runs with the same model/settings, task, starter, style inputs and quality gates. Track completion, fidelity, verification outcomes, elapsed time, prompt evaluation time, token counts, rereads and repair rounds. Character reduction alone is not a quality or speed result.

Do not restart a running task to load these changes. Activate on a later service restart. Live speed/quality improvements require benchmark evidence; unit tests cannot establish them.
