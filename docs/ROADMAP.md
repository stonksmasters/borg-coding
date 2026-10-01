# BORG Code Roadmap

Last updated: 2026-09-29

This roadmap is product-oriented. Historical alpha documents describe implementation milestones; this file describes the transition from BORG's website-builder foundation into a local AI operating layer with General Chat as its primary interface.

## Status legend

- Built: implemented foundation exists in the current repository.
- Active: current development frontier; implementation exists in part but the product capability is not yet reliable end to end.
- Next: intentionally next after the active frontier.
- Later: planned, but should not distract from the current reliability goals.

## Platform direction

The website builder remains the most mature focused workspace and the main proof of BORG's autonomous workflow. It is no longer the complete product boundary. BORG is expanding around a shared capability system used by General Chat, Development, Security, Knowledge, Infrastructure, Computer Control, Data, and Automation.

The canonical product direction is defined in [VISION.md](VISION.md). New domains must reuse the existing permission, workflow, persistence, activity, evidence, and verification foundations instead of creating separate agent runtimes.

## 0. Local coding runtime - Built

Foundation includes:

- local Ollama model execution;
- streamed tool use;
- task persistence;
- permission modes;
- isolated worktrees;
- repository inspection;
- terminal and process execution;
- checkpoints and continuations;
- review and repair infrastructure.

The runtime is no longer the primary product goal. It is the execution substrate for General Chat and every focused workspace, including the website builder.

## 1. Persistent coding workstation - Built / hardening

Foundation includes:

- persistent sessions;
- desktop launcher;
- local state restoration;
- mode and approval handling;
- task history;
- durable review decisions;
- guarded desktop synchronization.

Remaining work here should be treated as reliability hardening, not a reason to delay the website-builder product.

## 2. Browser verification and evidence - Built / hardening

Foundation includes:

- local preview execution;
- browser-driven verification;
- console and network evidence;
- responsive checks;
- screenshots;
- accessibility-oriented verification;
- visual-regression support;
- repair loops.

The ongoing goal is to make evidence more reliable and better integrated into the website workflow.

## 3. Website-first builder - Built / active

Current repository capabilities include:

- website project creation;
- original brief persistence;
- staged Project Blueprint planning;
- sitemap, routes, ordered page sections, and user journeys;
- Design Director art direction informed by the product map;
- implementation-grade global design-system planning before component architecture;
- component inventory derived from product structure and shared visual primitives;
- foundation-first ordered frontend slices;
- per-slice acceptance criteria;
- frontend completion gates;
- backend-required classification;
- generated build documentation;
- live preview integration.

The remaining challenge is not basic scaffolding. It is reliable autonomous continuation across a large multi-slice build.

## 4. Phased autonomous frontend workflow - Built / hardening

Target:

One brief -> approved plan -> slice 1 -> verify/repair -> handoff -> slice 2 -> ... -> finished frontend.

Key requirements:

- server-owned phase and slice state;
- no unnecessary full-repository replanning between passes;
- mini-loops inside slices;
- deterministic advancement rules;
- bounded repair;
- clean restart and recovery;
- frontend review as a real product boundary.

A large benchmark such as a social-commerce storefront should be able to run through multiple slices without losing coherence.

## 5. Context Compiler and project memory - Built / hardening

Current foundation:

- slice-scoped Context Compiler;
- authoritative workflow plan/slice input;
- pinned website product and design contracts;
- bounded inclusion budgets;
- source provenance manifests;
- deterministic persisted ContextPacks;
- separate exact model-input audit records;
- slice/page/component/styles profiles;
- page/component registry context;
- repository-memory symbol/import source hints;
- handoff and decision compression;
- recorded model inputs for diagnostics;
- tests for bounded relevance, deterministic replay, restart persistence, and exclusion.

Hardening remains focused on improving source-map freshness, evidence/repair overlays, and keeping critical contracts pinned under local-model context pressure.

## 6. Execution observability - Built / consolidation

Current foundation:

- server-owned RunView derived from durable task/workflow state;
- structured activity feed and execution inspector;
- current phase, slice, action, next transition, and blocker;
- verification and repair visibility;
- Preview / Plan / Changes / Evidence product surfaces;
- advanced logs, project memory, and raw context diagnostics;
- persisted state as the normal UI source of truth.

Consolidation work should continue to remove duplicate status derivation and improve evidence summaries without exposing unnecessary runtime internals.

## 7. First-class Pages and Components - Partial / next

Target:

Represent project structure as product entities, not only files.

Deliverables:

- page registry;
- component registry;
- source/dependency mapping;
- page and component navigation;
- dedicated scoped workspaces;
- focused previews;
- focused verification;
- entity edit history;
- entity-scoped Context Compiler profiles.

This should materially reduce context size for iterative work.

## 8. High-quality component and page corpus - Later

Target:

Build a trustworthy local corpus of reusable UI assets.

First phase:

- collect components and page patterns;
- retain screenshots and evidence;
- retain provenance;
- classify variants;
- record supported states;
- establish promotion quality gates.

Do not automatically inject corpus items into model context yet.

## 9. Component-library intelligence - Later

Only after the corpus is useful and trustworthy:

- semantic and structural retrieval;
- design-fit matching;
- dependency-aware suggestions;
- adaptation rather than blind copying;
- deduplication;
- quality-weighted selection;
- project-aware recommendations.

Retrieval should improve design quality rather than homogenize it.

## 10. Full autonomous full-stack builder - Later

Target:

Extend the same disciplined workflow beyond frontend completion.

Capabilities include:

- backend phase planning;
- data models;
- authentication;
- persistence;
- integrations;
- payments;
- admin/seller tooling;
- server verification;
- end-to-end flows;
- deployment readiness;
- security and dependency review near delivery.

Backend should be driven by the approved product contract, not invented prematurely.

## 11. General Chat command surface - Next

Target:

Make persistent Chat the front door to every BORG capability.

Deliverables:

- durable general conversations and attachments;
- model selection and routing behind provider adapters;
- per-conversation tool and network permissions;
- shared activity, approvals, artifacts, and results;
- capability selection without exposing raw command construction;
- compact durable memory and bounded context compilation;
- links into focused workspaces when structured inspection is useful.

## 12. Shared capability and job runtime - Active / next

Target:

Give Chat, workspaces, and future automations one typed execution system.

Deliverables:

- typed capability definitions and schemas;
- provider and execution-node adapters;
- explicit target and workspace scope;
- ASK / PLAN / EDIT / AGENT policy evaluation;
- durable jobs, steps, streaming, cancellation, and timeout;
- inspectable side effects and artifacts;
- normalized evidence and verification records;
- capability discovery that does not grant execution permission.

Existing development and security code should converge on these shared primitives incrementally.

## 13. Security and Kali provider - Active

Current foundation includes:

- assessment scope and authorization state;
- generic SSH execution nodes;
- provider health and capability discovery;
- typed DNS and service-inventory operations;
- workflow approvals and durable executions;
- raw and normalized evidence;
- assessment assets, services, observations, and relationships;
- Security workspace UI;
- Kali tool registry, policy, and investigation planning;
- typed public username and email footprint adapters.
- an SSH-stdio Kali MCP provider with health and tool discovery;
- typed DNSRecon, Maigret, Holehe, PhoneInfoga, WhatWeb, Gobuster, and Nmap MCP adapters;
- typed Whois, Wafw00f, SSLyze, DNSenum, DNSmap, Fierce, passive Amass, and DMitry adapters;
- typed sslscan, FFUF, DIRB, Nikto, WPScan, and Wfuzz adapters with bounded request rates and run times;
- typed arp-scan, fping, Ike-scan, enum4linux, anonymous smbclient, and read-only SMBMap adapters for approved hosts and CIDRs;
- exact-scope ExifTool, hashdeep, offline TShark, and SearchSploit adapters for remote evidence files and software queries;
- domain discovery normalization into hostname assets, address observations, email candidates, and evidence-backed subdomain relationships;
- passive auto-run policy, active approval gates, cancellation, and guided package installation;
- identity assets, confidence, rationale, and evidence-backed relationships;
- General Chat tools for investigation planning and case retrieval.

Next milestones:

1. inventory every installed Kali security executable and expose integration
   state separately from installation state;
2. complete Wave 1 recon adapters for identity, domain, network, TLS, and web
   discovery, with fixtures and live Pi verification for each operation;
3. build profile metadata extraction, account clustering, correlation scores,
   and conflict handling before identity tools are exposed to General Chat;
4. add structured progress and partial-result streaming for long-running MCP
   calls such as full Maigret, SpiderFoot, Amass, and GVM jobs;
5. complete Wave 2 evidence adapters for packet, file, metadata, TLS, and
   vulnerability analysis;
6. add reviewed, pinned installers for useful tools absent from Kali packages;
7. implement Wave 3 assisted workflows and Wave 4 restricted adapters with
   explicit authorization and approval boundaries;
8. expose only verified operations to model planning after deterministic
   end-to-end evaluation passes.

Kali remains an execution node. Workflow and investigation authority stay in BORG.

## 14. Files and Knowledge - Later / platform priority

Target:

Index and retrieve local files, documents, repository knowledge, decisions, and prior work without placing whole collections in model context.

This domain should reuse the Context Compiler, provenance, entity, evidence, and permission foundations.

## 15. Infrastructure and Computer Control - Later

Target:

Operate trusted local and remote systems through visible, inspectable capabilities: services, containers, logs, health, backups, applications, and GUI-only workflows.

## 16. Automation - Later

Target:

Schedule or trigger proven capabilities using the same policy, scope, job, evidence, and notification system used for interactive work.

## Immediate development order

The current cross-product priority order is:

1. preserve and benchmark the website builder's multi-slice workflow, Context Compiler, RunView, and verification foundations;
2. establish General Chat as the persistent command surface;
3. consolidate a shared typed capability and durable job contract from the existing development and security paths;
4. complete Kali MCP/SSH provider integration through the existing security scope, policy, approval, and evidence boundary;
5. deepen identity recon and the security case graph with provenance and confidence;
6. add Files and Knowledge retrieval using bounded context and citations;
7. extend the same provider system into infrastructure and visible computer control;
8. add automation only after the underlying interactive capabilities are reliable.

Within the Development workspace, language-backed Page/Component mappings, scoped workspaces, quality corpus work, and eventual full-stack construction remain the ordered product path.

## Benchmark principle

Use realistic, difficult builds to drive the roadmap.

Benchmarks should expose:

- loss of project coherence;
- context bloat;
- repeated planning;
- weak design;
- broken preview behavior;
- verification gaps;
- recovery failures;
- false completion claims.

Fix the architectural cause rather than teaching the benchmark prompt to work around it.
