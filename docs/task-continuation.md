# Task checkpoints and continuation

BORG stores immutable task checkpoints and append-only continuation attempts in the canonical SQLite task database. A checkpoint records the durable task state, permission mode, repository/worktree identity, approval state, saved plan, completed and remaining lifecycle steps, active specialist context, last durable event, workflow version, verification gate, and recovery descriptor.

## Checkpoint boundaries

Automatic checkpoints are created when a plan reaches approval, before approved editing, after implementation, after verification, before bounded repair, before delivery, and when startup detects that the previous process stopped during a mutation-capable stage. Operators may also create named checkpoints from the desktop task timeline.

Checkpoints are immutable. Creating another checkpoint never overwrites an earlier snapshot.

## Continuation safety

Continuation reconstructs state from SQLite and current Git evidence. It never attempts to restore process IDs, terminals, browsers, language servers, file handles, or in-memory agent loops.

- ASK and PLAN checkpoints retain their recorded read-only mode.
- A saved plan may return to `AWAITING_APPROVAL`, but approval must be decided again when required.
- Delivery may resume only when the managed worktree still exists and its recorded base remains an ancestor of the current HEAD.
- Interrupted IMPLEMENTING, VERIFYING, REVIEWING, or DELIVERING stages enter `RECOVERY_REQUIRED`.
- Mutation-stage continuation never automatically replays the last tool call or agent response.
- Missing, escaped, or diverged worktrees require explicit recovery.
- Recovery-required continuations restore PLAN mode until mutation authority is valid again.
- Post-verification continuation cannot restore REVIEWING or DELIVERY_READY unless the checkpoint itself contains a passed verification gate.
- Restart recovery persists the exact recovery category, interrupted state, checkpoint ID, reason, and safe resume action instead of reconstructing them from UI history.

The continuation timeline records the parent continuation, previous and resulting task state, restored mode, repository validation state, required next action, and human-readable recovery detail.

## API

- `GET /api/tasks/:taskId/checkpoints`
- `POST /api/tasks/:taskId/checkpoints`
- `GET /api/tasks/:taskId/continuations`
- `POST /api/tasks/:taskId/continuations`

The desktop gateway proxies these endpoints to the canonical task service. The workspace checkpoint panel creates named snapshots and displays continuation/recovery outcomes.
