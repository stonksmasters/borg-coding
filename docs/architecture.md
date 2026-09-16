# Architecture

BORG Code is a single local-first application with one root npm dependency graph. The source is split into layers for maintainability, but `apps/` and `packages/` are not independent package-manager workspaces.

## Canonical runtime

1. **Workspace UI (`app/`)** — operator task thread, repository access, permission mode, approvals, implementation progress, review findings, and delivery controls.
2. **Local agent server (`apps/server/src/`)** — owns task orchestration, Ollama interaction, state transitions, approval handling, deterministic verification, repair loops, fresh-context review, and delivery endpoints.
3. **Core domain (`packages/core/src/`)** — runtime-validated task/finding/event contracts and legal task-state transitions.
4. **Repository boundary (`packages/repository/src/`)** — approved repository access, isolated Git worktrees, and non-destructive delivery.
5. **Tool broker (`packages/tools/src/`)** — permissioned repository inspection, TypeScript/JavaScript structural navigation, bounded worktree mutation/commands, Git inspection, verification, and optional public-web tools.
6. **Language intelligence (`packages/language-intelligence/src/`)** — provider-neutral symbol navigation. The TypeScript Language Service is the first provider and is filtered through the same approved-repository access policy as normal reads.
7. **Browser verification (`packages/browser-verification/src/`)** — task-isolated, loopback-only Chromium and development-server lifecycle with DOM, interaction, console, network, screenshot, responsive, and accessibility evidence.
8. **Vision review (`packages/vision-review/src/`)** — optional provider-neutral screenshot review with local Ollama as the first adapter, strict provenance checks, structured findings, and explicit unavailable/failed/inconclusive outcomes.
9. **Runtime adapters (`packages/runtimes/src/`)** — local model/runtime boundaries, including OpenCode compatibility.
10. **Persistence (`packages/persistence/src/`)** — SQLite task, event, approval, and finding history.
11. **Desktop host (`apps/desktop/`)** — Windows launcher, tray lifecycle, and WebView2 shell around the same local application.

## Task flow

The canonical mutation flow is:

`DISCOVERING → PLANNING → AWAITING_APPROVAL → IMPLEMENTING → VERIFYING → REVIEWING → DELIVERY_READY → DELIVERING → COMPLETE`

Verification or independent review may schedule a bounded repair loop back to `IMPLEMENTING`. Exhausted repair attempts become `BLOCKED`; failed runtime operations become `FAILED`.

All code mutation happens in an approved task-scoped detached worktree under `.borg/worktrees`. Delivery exports a patch or creates a commit in that isolated worktree; it never silently mutates the user's primary checkout.

## Permission modes

- **ASK** — conversational mode; repository and mutation tools are unavailable.
- **PLAN** — approved repository inspection and structural code navigation are available, but mutation is not.
- **EDIT** — after explicit plan approval, BORG can mutate the isolated worktree and run bounded verification tools.
- **AGENT** — same isolation boundary as EDIT with the broadest configured autonomous tool access.

Permission enforcement belongs in the server/tool layer, never only in the frontend.

## Repository intelligence

Literal search and structural navigation are complementary. For TypeScript/JavaScript, BORG can search symbols, inspect file outlines, resolve definitions/references/implementations, request quick information, and run language-service diagnostics. These tools are read-only and may only index paths accepted by `AccessController`.

## Verification contract

The root project is the source of truth for local and CI verification:

```text
npm run install:ci
npm run check
npm test
npm run build
```

GitHub Actions runs that same contract. Package-level build scripts and the former pnpm workspace pipeline are intentionally not part of the canonical architecture. Browser evidence is additive: for web tasks, the latest structured browser report is attached to the deterministic verification result. When local vision review is enabled, provenance-checked screenshots are reviewed after deterministic verification and before fresh-context code review. Blocking visual findings use the existing bounded repair loop; unavailable, failed, and inconclusive outcomes remain explicit task events and never masquerade as a pass.
