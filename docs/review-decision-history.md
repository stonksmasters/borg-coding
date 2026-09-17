# Review decision history

Review findings are durable task records. A new review does not delete the prior pass.

## Storage model

- `review_runs` records each independent review pass and links it to the latest checkpoint and continuation.
- `review_finding_records` stores one current projection per stable task/fingerprint pair.
- `review_finding_occurrences` preserves exactly what each run observed.
- `review_decisions` is an append-only audit log of system and operator decisions.
- `findings` remains a compatibility projection for older clients; it is not the review-history authority.

The fingerprint normalizes discipline, category, path, and title. Generated finding IDs and line numbers are intentionally excluded so a small repair-induced line shift does not create a duplicate issue.

## State rules

- New findings start `open`.
- `open`, `accepted`, and `reopened` high/critical findings block delivery.
- An omitted finding remains active by default.
- A repair pass may mark an absent active finding `fixed` only when deterministic verification passed and a fresh review did not reproduce it.
- A fixed finding observed again becomes `reopened`.
- Waivers and false-positive decisions require an operator reason.
- Critical findings cannot be waived.
- Marking fixed requires verification evidence.
- Reviewer/system reconciliation cannot overwrite waived, false-positive, or superseded operator state.

## API

`GET /api/tasks/:taskId/review-history` returns runs, current finding projections, occurrences, decisions, and blocking finding IDs.

`POST /api/tasks/:taskId/review-history` appends an operator decision. The body contains `findingId`, `action`, `reason`, and `evidence`. Delivery state is recalculated after the decision.

## Continuation behavior

Checkpoint continuation keeps review history attached to the task. The continuation event includes unresolved blocking finding IDs and its detail reports their count. Resuming never erases, re-identifies, or silently resolves a finding.
