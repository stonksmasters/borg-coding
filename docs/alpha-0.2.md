# BORG Code Alpha 0.2 — browser-driven verification

## Implemented vertical slice

- A controlled Playwright Chromium runtime is available only in approved EDIT and AGENT task worktrees.
- Browser navigation is restricted to HTTP(S) loopback applications. Non-loopback page requests, redirects, WebSockets, fonts, scripts, images, and API calls are blocked and recorded as network evidence.
- BORG can start and stop an allowlisted local development-server process without shell interpolation. The server working directory remains inside the approved task worktree.
- Each task receives an isolated browser session with bounded console, failed-request, blocked-request, and HTTP-error evidence.
- DOM inspection returns bounded structural evidence: stable selector hints, tag, role/name, visible text, link targets, disabled state, visibility, and bounding rectangles.
- Browser interactions support click, fill, key press, check, uncheck, and select operations through bounded CSS selectors.
- Screenshot captures are stored under the isolated worktree at `.borg/evidence/browser/`, include SHA-256 provenance, and never enter the primary checkout.
- Responsive verification captures mobile, tablet, and desktop evidence by default, with up to eight explicitly requested viewports.
- Accessibility verification injects the local pinned `axe-core` runtime and returns structured violations, incomplete checks, pass counts, affected targets, HTML evidence, and remediation summaries.
- The latest browser evidence report is attached to `verification_run`. The same verification payload is persisted and passed into fresh-context review and evidence-driven repair.
- Browser sessions and managed development servers are closed automatically when deterministic verification begins.

## Runtime prerequisites

BORG uses `playwright-core` without downloading a private browser build. On Windows it defaults to the installed Microsoft Edge channel. Other platforms default to Google Chrome.

Override discovery when needed:

- `BORG_BROWSER_CHANNEL=msedge|chrome|chromium`
- `BORG_BROWSER_EXECUTABLE_PATH=/absolute/path/to/browser`

## Evidence workflow

1. `browser_server_start` starts the application and waits for a loopback URL.
2. `browser_open` creates a task-isolated browser context.
3. `browser_dom` and `browser_interact` inspect and exercise the interface.
4. `browser_capture` records DOM, screenshot, console, network, and accessibility evidence.
5. `browser_responsive` repeats evidence collection across bounded viewports.
6. `verification_run` closes browser resources and attaches the latest report to deterministic command evidence.
7. Fresh review receives the verified diff, deterministic results, and browser report.

## Remaining Alpha 0.2 work

- Optional local vision-model review over the screenshot evidence contract.
- Named visual baselines and pixel/regression comparison profiles.
