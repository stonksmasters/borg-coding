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
- The latest browser evidence report is attached to `verification_run`. Missing DOM/screenshots, console errors, failed or blocked requests, HTTP errors, and serious/critical accessibility violations fail the combined verification and enter the same bounded repair loop.
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
7. When enabled, local vision review validates screenshot provenance, sends at most three screenshots plus bounded browser evidence to the configured provider, and returns structured findings.
8. Blocking vision findings enter the same bounded repair loop; unavailable, failed, or inconclusive review is recorded explicitly without being represented as a pass.
9. Fresh review receives the verified diff, deterministic results, browser report, and any non-blocking vision findings.

## Local vision review

Local vision review is disabled by default and uses the provider-neutral `VisionReviewProvider` contract. The first adapter calls the local Ollama API with `qwen3-vl:8b` by default.

Configure it in the Tools dialog or through `POST /api/vision`:

- `enabled` — opt in to screenshot review.
- `model` — local Ollama vision model tag.
- `maxScreenshots` — bounded from one to six; defaults to three.
- `timeoutMs` — bounded request timeout; defaults to 180 seconds.
- `blockingSeverity` — minimum finding severity that requests repair; defaults to high.

Before image bytes leave the worktree boundary, BORG verifies that every screenshot resolves inside the approved worktree, rejects symlink escapes, enforces a 12 MB limit, and recomputes the SHA-256 digest recorded by browser verification. The reviewer receives screenshots as untrusted evidence and produces schema-constrained findings with screenshot path/hash, viewport, confidence, and selector provenance.

## Deterministic visual regression

Repositories opt in by adding `.localcode/visual-regression.json`. Profiles select quick or full verification, optionally select screenshot names, define per-pixel sensitivity, set percentage and absolute changed-pixel budgets, and declare bounded ignored regions.

```json
{
  "version": 1,
  "baselineRoot": ".localcode/visual-baselines",
  "profiles": [
    {
      "id": "app-shell",
      "verificationProfiles": ["quick", "full"],
      "screenshotNames": ["responsive-mobile", "responsive-desktop"],
      "pixelThreshold": 0.1,
      "maxChangedPixelRatio": 0.01,
      "maxChangedPixels": 500,
      "ignoreRegions": [{ "x": 0, "y": 0, "width": 120, "height": 40 }]
    }
  ]
}
```

Baseline PNGs are durable repository files under the configured baseline root. Current screenshots and highlighted diff images remain task evidence under `.borg/evidence/`. Every candidate and baseline is constrained to the approved worktree, limited by size and dimensions, and hash-checked against browser evidence.

Comparison outcomes are explicit:

- `pass` — changes remain inside both configured budgets.
- `regression` — changed pixels exceed a percentage or absolute budget and enter bounded repair.
- `missing-baseline` — verification may continue, but the workspace presents an explicit acceptance control.
- `dimension-mismatch` — verification fails until the layout is repaired or a new baseline is deliberately accepted.
- `failed` — malformed configuration, unsafe paths, tampered evidence, or unsupported images fail verification.

BORG never creates or replaces a baseline autonomously. After review reaches `DELIVERY_READY`, the operator may accept the verified missing-baseline candidates. Accepted files remain in the isolated worktree and are included in the normal patch or commit delivery.

## Alpha 0.2 completion

Alpha 0.2 now combines deterministic DOM, console, network, responsive, accessibility, and pixel-regression evidence with optional local semantic vision review. The next roadmap phase can build specialist engineering roles on top of this shared evidence contract.
