# BORG Product Vision

Last updated: 2026-09-29

## North star

BORG is a private, local-first AI operating layer for the user's computer, projects, services, and trusted remote machines.

General Chat is the primary interface. From one persistent conversation, the user can ask BORG to build software, inspect local knowledge, operate approved tools, manage infrastructure, run security investigations, analyze data, and create automations. Focused workspaces provide richer controls and evidence for those same shared capabilities.

BORG is not a generic chatbot and should not become a collection of unrelated AI applications. Its value comes from a coherent local capability graph around replaceable models.

## Target experience

The user should be able to say:

- "Build this website and verify it in the browser."
- "Investigate this username using public sources."
- "Map my home network and explain what is exposed."
- "Find the document where we agreed to the 60-day clause."
- "Figure out why the Raspberry Pi is slow."
- "Compare yesterday's benchmark with the current implementation."
- "Run this workflow whenever a new file appears in this folder."

BORG determines which typed capabilities are relevant, shows its proposed or active work, enforces the current permission mode and target scope, executes through an appropriate provider, preserves evidence, verifies the result, and explains what happened.

## Product model

```text
                            BORG
                              |
                        GENERAL CHAT
                              |
                  Intent and Capability Registry
                              |
        +---------------------+----------------------+
        |                     |                      |
   Development          Security and Recon      Knowledge
        |                     |                      |
   repositories             Kali                 local files
   browser                  network               documents
   Git                      OSINT                 research
        |                     |                      |
        +---------------------+----------------------+
                              |
                         Automation
                              |
                    +---------+---------+
                    |                   |
                Local PC          Trusted nodes
                                      Pi/server/NAS
```

Chat and workspaces are two views of the same system. A capability invoked from Chat must use the same provider, policy, job, evidence, and persistence infrastructure as one invoked from a focused workspace or automation.

## Product principles

### Chat is the command surface

Regular chat is a first-class product. It owns persistent conversations, attachments, model selection, memory, tool permissions, activity, and results. Focused workspaces remain available when a task benefits from structured forms, graphs, previews, cases, or detailed evidence.

### Models choose intent; BORG controls execution

The model may propose a goal or choose a registered capability. It should not invent opaque side effects.

```text
User request
  -> typed BORG capability
  -> permission and scope checks
  -> execution provider
  -> validated tool adapter
  -> job and artifacts
  -> normalized evidence
  -> user-facing explanation
```

Filesystem, shell, Git, browser, desktop, network, and verification effects remain explicit and inspectable. A model adapter must never hide a tool side effect.

### One shared capability system

New workspaces add capability families rather than parallel agent runtimes. Development, security, knowledge, infrastructure, data, media, and automation share:

- typed capability definitions;
- provider adapters;
- ASK / PLAN / EDIT / AGENT permission semantics;
- target and workspace boundaries;
- durable jobs and cancellation;
- activity and progress events;
- artifacts and evidence;
- verification and review;
- local persistence.

### Replaceable providers

Models and execution locations are implementation choices behind adapters. Ollama and `qwen3-coder:30b` are the initial model runtime. The local Windows machine is the initial execution environment. Kali, Raspberry Pis, servers, and future workers are execution providers or nodes, not separate sources of workflow authority.

### Persistent knowledge, bounded context

BORG remembers projects and investigations without repeatedly sending entire conversations, repositories, or document collections to a model.

Durable knowledge belongs in SQLite and inspectable `.localcode/` projections. Model context is compiled for the current task from relevant sources, decisions, entities, and evidence.

### Observable autonomy

The user can always determine:

- what BORG is trying to accomplish;
- what capability and provider it selected;
- what scope and permission apply;
- what it is doing now;
- which files, systems, or targets are affected;
- what evidence was collected;
- what verification passed or failed;
- whether it is working, blocked, awaiting approval, or complete.

### Human control at meaningful boundaries

ASK / PLAN / EDIT / AGENT semantics apply across the product. BORG can continue autonomously inside approved boundaries, while scope changes, intrusive security operations, destructive actions, publishing, and other consequential transitions remain visible and governed by policy.

### Evidence before claims

Results retain provenance: source, tool, timestamp, target, raw artifact, normalized observation, relationship, and confidence where applicable. Security and research correlations distinguish confirmed, strong, possible, unverified, and conflicting relationships.

### Local and private by default

Local models, storage, repositories, files, and execution are the default. Internet access and external providers are deliberate capabilities with visible boundaries.

### Windows 11 is a first-class target

BORG's desktop, process, filesystem, shell, and provider abstractions must work reliably on Windows. Linux systems such as Kali extend the local system as trusted workers.

## Capability families

### General Chat

Persistent conversation, attachments, model routing, memory, web access controls, voice in the future, and access to the full capability registry.

### Development

Website and application creation, repository work, planning, implementation, Git, tests, browser verification, repair, review, and resumable multi-slice workflows. The website builder remains BORG's most mature focused workspace and a proving ground for the shared runtime.

### Security and Recon

Authorized OSINT, asset discovery, network and web assessment, traffic and file analysis, evidence collection, and reporting. Kali acts as a sensor and execution platform. BORG owns scope, approval, orchestration, normalized results, and cases.

### Files and Knowledge

Local indexing, retrieval, comparison, citations, repository knowledge, document understanding, and inspectable personal or project memory.

### Computer Control

Visible operation of local applications and GUI-only workflows with explicit permissions, screenshots, and audit history.

### Homelab and Infrastructure

Trusted machines, SSH, containers, virtual machines, NAS devices, services, logs, backups, health, and resource usage.

### Automation

Scheduled and event-driven workflows built from the same capabilities and permission system used interactively.

### Data and Analytics

CSV, JSON, databases, logs, benchmark results, SQL, Python analysis, anomaly detection, and local dashboards.

### Media

Local image, audio, and video inspection and transformation, transcription, metadata, subtitles, and batch processing.

### Model Lab

Install, inspect, benchmark, compare, and route local models based on quality, speed, memory use, and task type.

### Remote Access

A phone or another trusted client can chat, review activity and diffs, inspect previews, approve governed work, and receive useful alerts without exposing raw machine control by default.

## Kali and security architecture

Kali is a security execution provider, not the place where an investigation lives.

```text
BORG Chat or Security Workspace
  -> Security capability
  -> ScopeGuard and operation policy
  -> KaliProvider
  -> MCP or SSH transport
  -> fixed typed adapter
  -> Kali tool
  -> raw artifact and normalized result
  -> BORG case, asset graph, and evidence
```

The Kali MCP server can provide transport and discovery, while BORG retains control over allowed targets, risk levels, arguments, timeouts, cancellation, artifacts, parsers, evidence, correlation, approvals, and audit history. Raw terminal access may exist as an explicit advanced capability; it is not the default model interface.

## Identity recon direction

Identity recon is an orchestrated investigation rather than a single lookup:

```text
username, email, phone, domain, name, or alias
  -> approved public-source adapters
  -> normalized identities and accounts
  -> evidence-backed relationships
  -> confidence and conflict analysis
  -> investigation case
```

Initial free/local adapters may include Sherlock and Maigret for usernames, theHarvester and public profile or domain checks for email clues, PhoneInfoga for phone enrichment, and DNS/public-web sources for pivots. No single account match establishes identity. Every correlation must retain its evidence and reason.

Phone recon should be presented as validation, geographic/carrier clues, and public-source pivots. It must not imply that free tooling can reliably identify a subscriber.

## Security capability levels

- Level 0 — Passive: OSINT, public DNS, public metadata, and local file inspection.
- Level 1 — Discovery: approved host discovery, service identification, and website discovery.
- Level 2 — Security scanning: vulnerability templates, configuration checks, TLS inspection, and authenticated assessment.
- Level 3 — Active lab testing: credential auditing, MITM simulations, wireless testing, and other intrusive lab operations.
- Level 4 — Exploit validation: controlled exploit and post-exploitation validation.

Policy determines which levels can run automatically within approved scope. Intrusive operations require explicit scope and approval.

## Shared durable concepts

The platform should converge on a small set of reusable concepts:

- conversation;
- project or case;
- capability;
- provider and execution node;
- scoped target;
- job and step;
- permission or approval;
- event and activity;
- artifact and evidence;
- entity, observation, and relationship;
- verification and review;
- decision and handoff.

Focused domains may extend these concepts, but should not create competing orchestration authorities.

## Development direction

The near-term platform sequence is:

1. make General Chat a durable command surface;
2. extract and harden the shared typed capability and job runtime;
3. complete the Kali provider path with health, MCP/SSH transport, discovery, and one verified end-to-end operation;
4. expand the security case, identity, asset, relationship, and evidence model;
5. add carefully typed recon adapters incrementally;
6. add local Files and Knowledge retrieval through the same capability system;
7. extend trusted-node infrastructure and visible computer control;
8. build automation on top of proven interactive capabilities.

Existing website-builder reliability work continues because it validates long-running autonomy, context compilation, browser evidence, repair, and handoffs. New platform work should reuse those foundations rather than replace them.

## Success criteria

BORG is moving toward the target when it can repeatedly:

- begin from a natural-language request in General Chat;
- choose only capabilities relevant to the request;
- keep every side effect explicit and within the selected scope;
- execute locally or on a trusted node through replaceable providers;
- preserve progress across restarts and long-running work;
- compile bounded, relevant model context from durable knowledge;
- stream understandable activity without exposing hidden reasoning;
- retain evidence and provenance for material claims;
- verify outcomes using the appropriate deterministic or visual checks;
- resume work without forcing the user to reconstruct prior context;
- expose the same operation coherently through Chat, workspaces, and automation.

The goal is a dependable local AI system that can understand, operate, verify, and remember work across the user's digital environment while keeping the user in control.
