# BORG LAN Remote v1

## Goal

LAN Remote is a thin phone client for the existing BORG desktop control plane. It does not own workflow progression, repository mutation, model execution, or debug state.

The desktop remains authoritative:

```text
Phone browser
  -> authenticated LAN remote gateway :4313
    -> desktop gateway :4312
      -> Core / WorkflowEngine :4311
```

## Start-up

The Windows desktop host starts the remote gateway automatically after the persistent desktop gateway is healthy.

For development:

```powershell
npm run remote:dev
```

The remote gateway listens on `0.0.0.0:4313`. The existing desktop gateway and Core remain loopback-only.

## Pair a phone

1. Start BORG Code on the PC.
2. On the PC, open `http://127.0.0.1:4313`.
3. BORG shows a six-digit pairing code and detected LAN URLs.
4. Connect the phone to the same Wi-Fi.
5. Open one of the displayed LAN URLs, for example `http://192.168.1.20:4313`.
6. Enter the six-digit code.

The code rotates when the remote gateway restarts. Successful pairing creates an HttpOnly, SameSite=Strict session cookie with a 24-hour maximum lifetime.

If Windows Defender Firewall prompts for Node.js network access, allow it only on **Private networks** for the same-Wi-Fi workflow.

## Remote capabilities

v1 intentionally exposes a bounded control surface:

- list BORG chat sessions;
- inspect the current session and transcript;
- inspect workflow status;
- inspect the sanitized Debug v1 snapshot;
- send a message through the normal desktop chat route;
- approve or reject a pending approval;
- retry a blocked/recovery task through the existing retry route;
- stop an active session runtime.

There is no arbitrary filesystem route, shell route, generic API proxy, SSH endpoint, or direct WorkflowEngine mutation endpoint.

## Stop semantics

`POST /api/sessions/:sessionId/stop` is owned by the desktop gateway. It aborts the same active stream/controller used by the desktop session.

LAN Remote does not invent a second cancellation state machine.

A durable pause/resume feature is intentionally not part of v1. It should be added only when Core owns an explicit persisted pause transition.

## Security boundary

The remote gateway:

- exposes port 4313 to the LAN;
- keeps Core and the desktop gateway on loopback;
- requires pairing before any `/api/remote/*` route;
- rate-limits failed pairing attempts per source address;
- uses an explicit route allowlist instead of a generic proxy;
- exposes the pairing code only to loopback requests;
- sends restrictive CSP, frame, referrer, and browser-permission headers;
- never exposes raw debug secrets or environment values beyond the existing sanitized Debug v1 contract.

LAN HTTP traffic is not encrypted. Treat v1 as a trusted-home/private-Wi-Fi feature, not an Internet-facing remote-access service.

## PWA behavior

The remote shell includes a web app manifest and service worker. Browsers only allow service workers in secure contexts such as HTTPS or loopback localhost, so a phone opening a private LAN IP over plain HTTP gets the full responsive remote web UI but may not get full install/offline PWA behavior.

A later remote-access phase can add trusted HTTPS (for example through a private overlay network) without changing WorkflowEngine ownership.

## Verification

The remote gateway integration test covers:

- static remote shell delivery;
- loopback-only setup information;
- unauthenticated denial;
- incorrect and correct pairing;
- session projection;
- workflow and sanitized debug projection;
- approvals;
- stop;
- chat streaming;
- rejection of non-allowlisted remote API paths.

Desktop lifecycle checks also treat `remote-gateway.ts` as a BORG-owned child process.
