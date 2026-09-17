# BORG Code Alpha 0.3 — discipline routing foundation

## Implemented vertical slice

- Every planned change is deterministically routed to one or more engineering disciplines: general, frontend, backend, database, security, QA, DevOps, and infrastructure.
- Architect, Implementer, Verifier, and Reviewer are explicit persisted assignments with their own model selection, status, attempt number, discipline, and capability set.
- Role handoffs persist the objective, constraints, repository context, completed work, changed files, evidence, open risks, and required next action.
- Tool permissions are enforced by the server-side broker. Architects inspect, Implementers mutate approved worktrees, Verifiers collect independent evidence without patch/command access, and Reviewers receive evidence without tool access.
- The workspace shows the active role and discipline and restores assignment/handoff history from SQLite.
- Optional repository policy in `.localcode/team.json` selects a default discipline and local Ollama model per role.
- Versioned specialist capability packs now make disciplines operational: instructions, tool eligibility, required evidence, verification depth, risk floors, failure taxonomies, and escalation rules are composed per task.
- Specialist pack references are persisted on every role assignment and exposed in the workspace. Frontend changes require passing browser evidence; database, security, QA, DevOps, and infrastructure work require the full deterministic profile.

## Team policy

```json
{
  "version": 1,
  "defaultDiscipline": "general",
  "roles": {
    "architect": { "model": "qwen3-coder:30b" },
    "implementer": { "model": "qwen3-coder:30b" },
    "verifier": { "model": "qwen3-coder:30b" },
    "reviewer": { "model": "qwen3-coder:30b" }
  },
  "disciplines": {
    "security": { "model": "security-specialist-local" },
    "frontend": { "model": null }
  }
}
```

The policy file must resolve inside the approved repository, be a regular file, remain below 100 KB, and pass strict schema validation. Missing model overrides fall back to `BORG_MODEL`.

## Role flow

1. The router classifies the request and persists the selected disciplines.
2. The Architect inspects approved context and produces the approval plan.
3. After approval, the Implementer changes only the task-scoped worktree.
4. The Verifier runs deterministic checks and browser/vision evidence where configured.
5. Failed verification hands bounded evidence back to the Implementer.
6. Passing evidence is handed to a fresh-context Reviewer.
7. Review findings either request bounded repair or unlock explicit delivery.

Each transition emits live workspace events and durable SQLite records. A process restart can therefore restore who was active and the most recent required next action.

## Specialist capability packs

The built-in v1 registry contains `general.core`, `frontend.web`, `backend.services`, `database.persistence`, `security.assurance`, `qa.verification`, `devops.delivery`, and `infrastructure.platform`.

Packs are composable policies, not personalities. The router activates only the disciplines supported by request and repository signals. Role permissions and specialist permissions are intersected in the ToolBroker, so a pack cannot grant a tool forbidden to the active role. Multiple packs combine their evidence requirements, choose the strongest required verification profile, and raise the task to the highest minimum risk level.

Frontend browser evidence is an objective gate: a routed frontend task cannot pass verification without a captured passing browser report. Other packs add deterministic requirements and reviewer failure taxonomies without pretending that model confidence is evidence.

## Canonical desktop checkout

The Windows shell launches the repository recorded in its shortcut working directory, so an old clone can otherwise look like a different application. The guarded sync workflow verifies the remote is exactly `stonksmasters/borg-coding`, fetches `origin/main`, reports drift, and refuses dirty, ahead, diverged, or non-main checkouts.

From the local canonical checkout:

```powershell
npm run desktop:status
npm run desktop:sync
```

`desktop:sync` only performs a fast-forward pull, locked dependency install, desktop rebuild, and shortcut refresh. It never resets, deletes, stashes, or rewrites local work. Exit BORG Code from the tray before rebuilding, or invoke `scripts/sync-desktop.ps1 -Apply -StopRunningApp` to stop it explicitly.

If the stale checkout predates the sync script, bootstrap it without rewriting history:

```powershell
Set-Location "$HOME\Documents\Codex\borg-code"
git remote get-url origin
git status --short --branch
git fetch origin main
git rev-list --left-right --count HEAD...origin/main
```

Proceed with `git pull --ff-only origin main` only when the remote is the canonical repository, the branch is `main`, the worktree is clean, and the left/ahead count is zero. Then run `npm run desktop:sync`. Otherwise preserve the checkout and reconcile its local work explicitly.

## Remaining Alpha 0.3 work

The routing, specialist-capability, polyglot language-server, cross-language graph, and persistent repository-memory foundations are complete. Alpha 0.3 still needs named checkpoints and continuation history, review-decision history, security dependency analysis, and task decomposition across independent specialist contexts.
