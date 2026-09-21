# BORG Code

BORG is a private local AI website builder: describe a website, approve the direction, and let a persistent local development system build, preview, verify, repair, and document the result.

The product goal is not a chat wrapper around a coding model. BORG is being built as a dependable website-development workstation that can carry a complex brief across many implementation slices without repeatedly forgetting the project, rereading the entire repository, or hiding its execution state from the user.

## Current product model

A website build follows this hierarchy:

    Project
      -> Phase
        -> Slice
          -> Context
          -> Implement
          -> Preview
          -> Verify
          -> Repair
          -> Document
          -> Handoff

Every new website begins with a frontend phase. BORG creates a tailored plan from the brief, including pages, features, design direction, ordered slices, and acceptance criteria. Each approved slice runs in its own bounded mini-loop while the website continues to use one primary project session. Backend work is a separate phase only when the finished product requires server behavior, persistence, accounts, integrations, payments, or similar capabilities.

The runtime underneath still provides durable tasks, permission modes, worktrees, checkpoints, role routing, browser verification, repair, review history, and Ollama-powered local agents. Those are implementation infrastructure; the website-building workflow is the product.

## Current development frontier

The main priority is reliable one-prompt, multi-slice frontend construction.

The active sequence is:

1. benchmark and harden the persistent multi-slice frontend workflow on difficult real projects;
2. harden the implemented Context Compiler and RunView rather than adding parallel context/progress systems;
3. replace heuristic page/component source relationships with language-intelligence-backed mappings;
4. add dedicated Page and Component workspaces with entity-scoped context and verification;
5. build a high-quality local component/page corpus with provenance and evidence;
6. add retrieval only after that corpus is trustworthy;
7. extend the same durable workflow into reliable full-stack construction.

## Canonical documentation

Start here:

- [Vision](docs/VISION.md) - north star, product principles, and success criteria.
- [Architecture](docs/ARCHITECTURE.md) - relationship between the website-builder product and the coding-agent runtime.
- [Website Builder](docs/WEBSITE-BUILDER.md) - canonical project, phase, slice, verification, and backend workflow.
- [Context System](docs/CONTEXT-SYSTEM.md) - durable project memory and the planned Context Compiler.
- [Pages and Components](docs/PAGES-AND-COMPONENTS.md) - first-class entity model and scoped workspaces.
- [Design Quality](docs/DESIGN-QUALITY.md) - Design Director, visual verification, and quality gates.
- [Observability](docs/OBSERVABILITY.md) - execution-state and activity-feed requirements.
- [Roadmap](docs/ROADMAP.md) - current product-oriented development sequence.
- [Alpha 0.3](docs/alpha-0.3.md) - historical/runtime implementation milestone and specialist-routing foundation.

BORG repository documentation describes BORG itself. Runtime-generated website project documentation under .localcode/build/ describes the individual website currently being built. Keep those sources of truth separate.

## Run the current system

    npm install
    npm run server:dev
    npm run gateway:dev
    npm run dev

The workspace runs at http://localhost:5173. The core task service listens on http://127.0.0.1:4311; the desktop/web gateway listens on http://127.0.0.1:4312 and is the browser UI's default API. Override the UI endpoint with NEXT_PUBLIC_BORG_API_URL, and override the gateway's core target with BORG_CORE_URL.

Task data is stored in .borg/borg.db and repository memory in .borg/repository-memory.db. Website projects are created locally and the gateway restores their previews across sessions. Agent tasks require the configured local Ollama model.

Use npm test, npm run check, npm run lint, and npm run build to verify the foundation.

## Windows desktop app

Build and install the native BORG Code launcher with:

    npm run desktop:install

This creates a BORG Code shortcut on the Windows desktop and enables launch at Windows sign-in. The desktop app starts Ollama, the local task API, and the Vinext workspace, then embeds the workspace in a native WebView2 window. Closing the window keeps BORG running in the system tray; use the tray menu to reopen it, toggle Windows startup, or exit and stop processes started by the launcher.

The launcher expects the existing Ollama installation and qwen3-coder:30b. Its logs are stored under .borg/desktop/, and the durable local build lives under artifacts/desktop/ so web builds cannot erase it.

If the desktop app looks different from the canonical repository, run npm run desktop:status from that checkout. After preserving any local work and exiting BORG from the tray, npm run desktop:sync performs only a fast-forward pull, locked dependency install, rebuild, and shortcut refresh. It refuses dirty, ahead, diverged, non-main, or wrong-repository checkouts and never resets or deletes local work.

Long tasks use bounded model/tool budgets and hard ceilings to stop runaway work. Advanced users can tune the supported BORG_MAX_* environment variables when debugging the runtime.

## Web-shell note

The browser workspace still uses the bundled Vinext/Vite/Cloudflare development shell because it provides the local preview and build environment used by the desktop app. That hosting scaffold is infrastructure, not BORG's application architecture. Historical generic Sites notes are kept in `docs/history/sites-runtime-scaffold.md`.

## Verification

Use one command to run the repository verification contract locally:

```text
npm run verify:all
```

On Windows this runs, in order:

- TypeScript typecheck
- ESLint
- the complete Node test suite
- the production web build
- the native Windows desktop lifecycle regression

For a clean CI-parity run that first replaces dependencies from the lockfile:

```text
npm run verify:clean
```

For the platform-independent core checks only:

```text
npm run verify:core
```

`verify:all` skips the desktop lifecycle stage on non-Windows platforms and reports that explicitly. If `node_modules` is missing, use `verify:clean`.

GitHub Actions uses the same `verify:core` runner after its locked dependency install, while the Windows job runs the same desktop lifecycle regression used by `verify:all`. This keeps the local and CI verification contracts aligned.
