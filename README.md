# BORG Code

BORG is a private, local-first AI operating layer for the user's computer, projects, services, and trusted remote machines. General Chat is the main command surface; focused workspaces provide deeper controls for development, security and recon, knowledge, infrastructure, and future automation.

The product goal is not a chat wrapper around a coding model. BORG surrounds replaceable local models with typed capabilities, explicit permissions and scope, durable jobs, inspectable tool effects, evidence, verification, and persistent local knowledge.

## Current product model

The platform path is:

    General Chat or focused workspace
      -> Typed capability
        -> Permission and scope policy
          -> Provider and execution node
            -> Explicit operation
              -> Artifacts, evidence, and verification

The website builder is currently the most mature focused workspace. Its workflow follows this hierarchy:

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

The runtime underneath provides durable tasks, permission modes, worktrees, checkpoints, role routing, browser verification, repair, review history, security execution nodes, evidence, and Ollama-powered local agents. These foundations are being consolidated into a shared capability runtime used by Chat and every focused workspace.

## Current development frontier

The active direction combines website-builder reliability with the broader platform foundation:

1. preserve and benchmark the persistent multi-slice Development workflow;
2. make General Chat the durable command surface;
3. consolidate a typed capability and job runtime shared by all domains;
4. complete the Kali MCP/SSH provider through the existing scope, approval, and evidence boundary;
5. deepen identity recon, cases, correlation, confidence, and provenance;
6. add local Files and Knowledge retrieval;
7. extend the provider model into infrastructure, computer control, and automation.

## Canonical documentation

Start here:

- [Vision](docs/VISION.md) - north star, product principles, and success criteria.
- [Architecture](docs/ARCHITECTURE.md) - General Chat, shared capabilities, workflow domains, providers, and runtime boundaries.
- [Website Builder](docs/WEBSITE-BUILDER.md) - canonical project, phase, slice, verification, and backend workflow.
- [Security](docs/SECURITY.md) - assessments, execution nodes, Kali tooling, policy, evidence, and recon adapters.
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
