# Architecture

BORG Code is a single local-first application with one root npm dependency graph. The source is split into layers for maintainability, but `apps/` and `packages/` are not independent package-manager workspaces.

## Canonical runtime

1. **Workspace UI (`app/`)** — operator task thread, repository access, permission mode, approvals, implementation progress, review findings, and delivery controls.
2. **Local agent server (`apps/server/src/`)** — owns task orchestration, Ollama interaction, state transitions, approval handling, deterministic verification, repair loops, fresh-context review, and delivery endpoints.
3. **Core domain (`packages/core/src/`)** — runtime-validated task/finding/event/role/handoff contracts and legal task-state transitions.
4. **Orchestration (`packages/orchestration/src/`)** — deterministic discipline routing, versioned specialist capability packs, bounded repository team policy, per-role/per-discipline model selection, risk floors, evidence gates, and role-plus-specialist capability enforcement.
5. **Repository boundary (`packages/repository/src/`)** — approved repository access, isolated Git worktrees, and non-destructive delivery.
6. **Tool broker (`packages/tools/src/`)** — permissioned repository inspection, TypeScript/JavaScript structural navigation, bounded worktree mutation/commands, Git inspection, verification, and optional public-web tools.
7. **Language intelligence (`packages/language-intelligence/src/`)** — provider-neutral symbol navigation. The built-in TypeScript Language Service and bounded local LSP adapters for Pyright, rust-analyzer, gopls, and csharp-ls are filtered through the same approved-repository access policy as normal reads.
8. **Browser verification (`packages/browser-verification/src/`)** — task-isolated, loopback-only Chromium and development-server lifecycle with DOM, interaction, console, network, screenshot, responsive, and accessibility evidence.
9. **Visual regression (`packages/visual-regression/src/`)** — repository-defined named profiles, deterministic PNG comparison, ignored regions, bounded change budgets, diff artifacts, and operator-approved baselines.
10. **Vision review (`packages/vision-review/src/`)** — optional provider-neutral screenshot review with local Ollama as the first adapter, strict provenance checks, structured findings, and explicit unavailable/failed/inconclusive outcomes.
11. **Runtime adapters (`packages/runtimes/src/`)** — local model/runtime boundaries, including OpenCode compatibility.
12. **Persistence (`packages/persistence/src/`)** — SQLite task, event, approval, finding, role-assignment, and handoff history.
13. **Desktop host (`apps/desktop/`)** — Windows launcher, tray lifecycle, and WebView2 shell around the same local application.

## Task flow

The canonical mutation flow is:

`DISCOVERING → PLANNING → AWAITING_APPROVAL → IMPLEMENTING → VERIFYING → REVIEWING → DELIVERY_READY → DELIVERING → COMPLETE`

Verification or independent review may schedule a bounded repair loop back to `IMPLEMENTING`. Exhausted repair attempts become `BLOCKED`; failed runtime operations become `FAILED`.

The responsibility flow is `Architect → Implementer → Verifier → Reviewer`. Assignments and evidence-rich handoffs are persisted independently of chat output. The server-side tool broker intersects the permission mode with the active role: only the Implementer may mutate, the Verifier cannot patch or run arbitrary commands, and the Reviewer receives a fresh evidence context without tools. Specialist packs add a second intersecting policy boundary: they may further restrict tools, select quick or full deterministic verification, require objective evidence such as a passing browser report, and provide failure taxonomies to fresh review. A specialist pack can never grant a capability denied by the active engineering role.

All code mutation happens in an approved task-scoped detached worktree under `.borg/worktrees`. Delivery exports a patch or creates a commit in that isolated worktree; it never silently mutates the user's primary checkout.

## Permission modes

- **ASK** — conversational mode; repository and mutation tools are unavailable.
- **PLAN** — approved repository inspection and structural code navigation are available, but mutation is not.
- **EDIT** — after explicit plan approval, BORG can mutate the isolated worktree and run bounded verification tools.
- **AGENT** — same isolation boundary as EDIT with the broadest configured autonomous tool access.

Permission enforcement belongs in the server/tool layer, never only in the frontend.

## Repository intelligence

Literal search and structural navigation are complementary. For TypeScript/JavaScript, Python, Rust, Go, and C#, BORG can search symbols, inspect file outlines, resolve definitions/references/implementations, request quick information, and run diagnostics through one normalized contract. External servers are discovered locally and are never installed automatically. Repository configuration may enable or disable known providers but cannot inject commands. These tools are read-only, enforce bounded requests and result counts, and may only read or return paths accepted by `AccessController`.

## Verification contract

The root project is the source of truth for local and CI verification:

```text
npm run install:ci
npm run check
npm test
npm run build
```

GitHub Actions runs that same contract. Package-level build scripts and the former pnpm workspace pipeline are intentionally not part of the canonical architecture. Browser evidence is additive: for web tasks, the latest structured browser report is attached to the deterministic verification result. Repository-defined visual profiles compare provenance-checked screenshots before fresh review; regressions, dimension mismatches, and unsafe comparison failures fail verification, while missing baselines require explicit operator acceptance and are never written automatically. When local vision review is enabled, the same provenance-checked screenshots receive a separate semantic review. Blocking visual findings use the existing bounded repair loop; unavailable, failed, and inconclusive outcomes remain explicit task events and never masquerade as a pass.
