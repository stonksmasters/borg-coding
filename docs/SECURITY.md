# BORG Security Workspace

This document defines the first implementation boundary for the Security workspace.

## Architectural rule

Security is a new BORG workflow domain, not a second orchestration authority.

- `WorkflowEngine` remains the sole authority for project progression.
- SQLite remains durable truth.
- Security assessments reference the same BORG `projectId` that future security workflow tasks will use.
- Kali and other Linux machines are execution nodes, not independent agents.
- The desktop gateway remains transport and must not invent security workflow state.

## Slice 1: durable security foundation

Implemented domain objects:

- `SecurityAssessment`
- `AssessmentScope`
- `ExecutionNode`
- `ExecutionCapability`

Implemented persistence:

- `security_assessment_scopes`
- `security_assessments`
- `execution_nodes`

The first node type is generic SSH. A Raspberry Pi running Kali is represented as an SSH execution node rather than by a Kali-specific persistence model. This keeps the execution layer reusable for future Linux servers or lab machines.

Credentials are represented only by `credentialRef`. Private keys and passwords do not belong in the SQLite domain snapshot.

## Safety and scope invariant

An assessment owns an explicit scope and records whether authorization has been confirmed. This slice persists the scope but does not yet execute security commands.

Future autonomous security execution must follow this path:

```text
WorkflowEngine
  -> security operation
  -> target extraction
  -> scope validator
  -> operation policy
  -> execution provider
  -> execution node
```

There must be no autonomous SSH path that bypasses the scope/policy gate.

## Next slice

The next implementation slice should add:

1. an `ExecutionProvider` contract;
2. `SSHExecutionProvider` with streaming stdout/stderr, timeout, cancellation and disconnect handling;
3. node health checks and capability discovery;
4. execution records/artifact metadata;
5. a fail-closed scope validator before active recon operations are introduced.

## Slice 2: SSH execution boundary and server API

The feature branch now also includes:

- a generic `ExecutionProvider` contract;
- `SshExecutionProvider` using the system SSH client with `shell: false`;
- POSIX argument quoting for the remote command boundary;
- timeout and AbortSignal cancellation;
- bounded stdout/stderr capture with truncation flags;
- SSH node health checks;
- Kali-oriented capability discovery without running recon;
- fail-closed scope evaluation for domains, hosts, and IPv4 CIDRs;
- an autonomous-operation policy that refuses manual operations and requires confirmed authorization before active recon;
- server APIs for registering/refreshing nodes and creating/reading assessments.

Current server routes:

```text
GET  /api/security/nodes
POST /api/security/nodes
POST /api/security/nodes/:id/refresh

GET  /api/security/assessments?projectId=...
POST /api/security/assessments
GET  /api/security/assessments/:id
```

The server still exposes no generic SSH shell endpoint and no recon endpoint. Refreshing a node only checks the remote platform/architecture and probes whether known tools are installed.

## Next implementation boundary

The next slice should make security operations first-class WorkflowEngine tasks, add durable execution/evidence records, and only then introduce a small structured recon adapter set (DNS lookup, host discovery, service inventory, HTTP probing) that is forced through the scope/policy gate.


## Slice 3: WorkflowEngine authority and durable evidence

Security assessments are now first-class WorkflowEngine tasks.

A security workflow uses `loop: "security"` and stores a durable security context:

```text
assessmentId
operationId
executionId
```

The workflow lifecycle is:

```text
CREATED
  -> CLASSIFYING
  -> DISCOVERING
  -> PLANNING
  -> AWAITING_APPROVAL
  -> IMPLEMENTING
```

Planning an operation does not execute anything. The server first validates the requested targets against the assessment scope and policy, persists a planned execution record, binds that execution to the authoritative workflow, creates the existing BORG execution approval, and stops at `AWAITING_APPROVAL`.

Approving the task moves the WorkflowEngine state to `IMPLEMENTING` and marks the security execution `approved`. It still does not dispatch SSH or recon commands in this slice.

Durable execution records include:

- assessment, task, and workflow version;
- selected execution node;
- operation ID and operation name;
- operation classification;
- explicit targets;
- provider;
- status and execution outcome metadata.

Durable evidence records include:

- assessment, task, and execution provenance;
- evidence kind;
- content type;
- SHA-256;
- byte length;
- truncation marker;
- optional storage URI;
- bounded inline text.

The evidence ledger is designed so later recon adapters can save raw stdout/stderr and normalized findings without making the UI, SSH provider, or model output the source of truth.

### Additional server routes

```text
POST /api/security/assessments/:id/workflow
POST /api/security/assessments/:id/operations
GET  /api/security/assessments/:id/executions
GET  /api/security/executions/:id/evidence
```

The existing task approval endpoint is reused for security execution approval. Security workflows do not require a repository binding or worktree.

## Next implementation boundary

The next slice can introduce structured recon adapters. Those adapters must not accept arbitrary shell strings. Each adapter should:

1. define a typed operation and target schema;
2. re-run scope/policy validation immediately before execution;
3. map the typed operation to a fixed executable + argument list;
4. dispatch through the approved execution node;
5. persist stdout/stderr evidence and normalized results;
6. transition the WorkflowEngine through verification/review based on recorded evidence.

## Slice 4: typed recon dispatch

The first executable operations are fixed typed adapters:

- `dns_lookup` uses `dig` and parses answer records;
- `service_inventory` uses an unprivileged, top-100-port Nmap TCP connect scan and parses XML output.

Approval now dispatches through the configured `ExecutionProvider`. Scope and policy are checked again immediately before execution. Node health and required capabilities must be current. Raw stdout and stderr are retained even on tool or parser failure, normalized JSON is recorded as evidence, and successful operations advance the authoritative workflow to `VERIFYING`.

The opt-in `npm run test:kali` integration test verifies the complete path against a real SSH node without adding hardware dependencies to normal CI.

## Slice 5: durable assets and observations

Normalized recon results now populate an assessment-scoped knowledge model:

- domain, IP address, and host assets;
- network services identified by host, protocol, and port;
- append-only observations for each execution;
- DNS resolution and alias relationships.

Stable assessment-scoped IDs deduplicate assets, services, and relationships across repeated scans. Observations retain history. Every entity records its latest execution and normalized evidence provenance, while each observation points directly to the execution and evidence that produced it.

Read APIs expose the model:

```text
GET /api/security/assessments/:id/assets
GET /api/security/assessments/:id/assets/:assetId
GET /api/security/assessments/:id/services
GET /api/security/assessments/:id/observations
GET /api/security/assessments/:id/relationships
```

## Slice 6: Security workspace

Security is now a first-class workspace in the local BORG interface. Open it from
**Workspaces > Security** in the left sidebar.

The workspace provides:

- execution node registration and capability refresh;
- assessment creation with explicit allowed domains, hosts, CIDRs, and exclusions;
- an authorization confirmation before an assessment can be created;
- WorkflowEngine start, typed operation planning, approval, and execution controls;
- overview and scope summaries;
- asset, service, evidence, and activity views backed by the durable security store;
- raw and normalized evidence inspection with provenance and SHA-256 metadata.

For a new local installation, register the Kali node first, then create an
assessment that selects that node. Planned operations remain subject to the
assessment scope and the existing BORG approval flow.

## Kali Agent Runtime — Slice 1: inspectable tool registry

The first general-agent foundation adds a typed registry of Kali tools. Each
entry declares its executable, purpose, category, default risk, network and
privilege behavior, evidence types, and whether BORG currently has a typed
adapter that can execute it.

Refreshing an execution node probes the registry and records availability and
version information on the node. The registry can be inspected with:

```text
GET /api/security/tools
GET /api/security/tools?nodeId=<execution-node-id>
```

Discovery does not grant execution permission. Tools marked `not_enabled`
remain inventory only. Tools marked `typed_adapter` still use the existing
assessment scope, policy, approval, execution, and evidence path.

## Kali Agent Runtime — Slice 2: tool requests and risk decisions

BORG can now propose a structured tool request containing the selected tool,
typed operation, purpose, arguments, explicit targets, expected evidence, risk,
and approval requirement. The broker derives risk from the registry, prevents a
request from downgrading its classification, reuses assessment scope policy, and
blocks tools without an enabled typed adapter.

```text
POST /api/security/assessments/:id/tool-requests
```

Accepted requests are stored inside the durable execution record. Passive local
tools may eventually be eligible to run without an execution approval. External
passive and active tools require execution approval, while intrusive tools carry
a distinct intrusive approval requirement. Slice 2 records that decision; the
existing WorkflowEngine approval gate remains authoritative for enabled tools.

## Kali Agent Runtime — Slice 3: investigation plans

An investigation starts with an objective and typed subjects: email, username,
domain, host, or CIDR. The planner produces ordered steps and stores the plan in
SQLite. Each executable step contains a complete Slice 2 tool request. Steps for
capabilities without typed adapters remain visible as blocked with a reason.

```text
POST /api/security/assessments/:id/investigation-plans
GET  /api/security/assessments/:id/investigation-plans
GET  /api/security/investigation-plans/:planId
```

This first planner is deterministic and grounded in the registry. Domain
subjects propose DNS lookup, host subjects propose bounded service inventory,
and email, username, and CIDR steps remain blocked until their typed adapters
exist. Creating a plan does not execute tools or create approvals.

## Kali Agent Runtime — Slice 4: public footprint adapters

Email addresses and usernames are explicit assessment targets with independent
allow and exclusion lists. `public_email_search` uses theHarvester against the
address domain and retains only exact matches for the authorized email.
`public_username_search` uses Sherlock and normalizes public profile URLs.
Both operations use the existing typed command, approval, cancellation, and
evidence path. The Security workspace exposes them for interactive testing.

## Kali MCP recon foundation

Kali nodes can now select `kali_mcp` as their security runtime. BORG starts the
official MCP bridge over SSH stdio and keeps the Kali HTTP service bound to
`127.0.0.1:5000` on the node. The model never receives the upstream
`execute_command` tool. Each MCP call is produced by a typed BORG adapter with
validated targets, fixed arguments, a timeout, and declared artifacts.

The initial adapter set is:

- domains: `dig`, DNSRecon, and theHarvester;
- usernames: Sherlock and Maigret;
- email addresses: theHarvester exact-address filtering and Holehe;
- phone numbers: PhoneInfoga enrichment;
- web targets: WhatWeb and bounded Gobuster discovery;
- hosts: bounded Nmap service inventory through BORG's typed MCP command wrapper.

Passive public-source operations run automatically after scope and policy
validation. Network discovery and more intrusive classifications still enter
the authoritative WorkflowEngine approval state. Every successful call stores
stdout, stderr, normalized JSON, provenance, identity assets, confidence, and
evidence-backed relationships. Active calls can be cancelled through:

```text
POST /api/security/executions/:executionId/cancel
```

Node refresh records the MCP server identity and discovered MCP tools. The
Security workspace also offers a guided baseline install. BORG previews a fixed
package plan, asks for explicit administrative approval, then passes a fixed
argument vector to `sudo apt-get`; tools without a reviewed package recipe are
reported as manual steps rather than interpolated into a command.

```text
POST /api/security/nodes/:nodeId/install-plan
POST /api/security/nodes/:nodeId/install
```

On Kali, install the official bridge and start its loopback service before
refreshing the node:

```text
sudo apt install mcp-kali-server
kali-server-mcp
```

For an always-on node, run that command as a system service under an unprivileged
account with `Restart=on-failure`, bind only to `127.0.0.1`, and order it after
`network-online.target`. The current Raspberry Pi node uses the service name
`borg-kali-mcp.service`.

The reviewed non-Kali-package versions currently used by the node are Maigret
0.6.6 and Holehe 1.61 in isolated pipx environments. PhoneInfoga is pinned to
the upstream ARM64 v2.11.0 archive and must pass its published SHA-256 checksum
before installation.

SSH and MCP transports use bounded connection retries plus TCP and application
keepalives. A production node should also have a DHCP reservation, wired
Ethernet where possible, Wi-Fi power saving disabled when wireless is required,
and a stable power supply. These host controls address reachability; transport
keepalives only detect and recover from short interruptions after the host is
on the network.

The current Raspberry Pi uses a dedicated point-to-point Ethernet link for the
BORG control path: Windows is `10.77.0.1/24`, Kali is `10.77.0.2/24`, and the
saved BORG node targets `10.77.0.2`. Kali keeps Wi-Fi as its default route for
internet access, with explicit `1.1.1.1` and `1.0.0.1` resolvers. This separates
the stable SSH/MCP path from DHCP address changes on the household Wi-Fi.

The opt-in live suite is `npm run test:kali` with `BORG_KALI_HOST` and optional
`BORG_KALI_USER` set. It verifies MCP discovery and real normalized results for
DNS lookup, bounded Nmap inventory, DNSRecon, WhatWeb, PhoneInfoga, Holehe,
Maigret, and bounded Gobuster discovery. Maigret writes reports under
`/tmp/borg-maigret-reports` because the system service's package directory is
read only. The Nmap and Gobuster operations use BORG's typed command wrapper
because their upstream native MCP handlers do not currently accept the argument
shape required by these bounded adapters.

General Chat receives narrow tools to list assessments, create deterministic
investigation plans, and read a case. It cannot issue raw Kali commands or
approve its own active operation.

## Persistent identity profiles

The Security workspace separates person research from infrastructure work.
**Profiles** contain a person's confirmed and candidate email addresses,
usernames, phone numbers, domains, and public URLs. **Cases** retain the existing
website, host, domain, and network assessment workflow.

Each profile owns an internal assessment scope, so confirmed identifiers are
entered once and reused by typed Kali adapters. Tool discoveries are stored as
candidate identifiers with evidence provenance. A candidate must be confirmed
before BORG can use it as a target; rejected candidates remain excluded from the
profile scope.

Profile tool runs use a durable FIFO queue. One operation runs at a time across
profiles, duplicate queued or running tool-target pairs are suppressed, and a
job interrupted by a server restart returns to the queue. Passive operations
reuse saved profile authorization. Active operations require both saved profile
authorization and an explicit job approval. The **Run passive suite** action
queues every available passive tool for every confirmed compatible identifier.

The profile API is rooted at:

```text
GET|POST             /api/security/profiles
GET|PATCH|DELETE     /api/security/profiles/:profileId
POST                 /api/security/profiles/:profileId/identifiers
PATCH                /api/security/profiles/:profileId/identifiers/:identifierId
POST                 /api/security/profiles/:profileId/jobs
POST                 /api/security/profiles/:profileId/passive-suite
POST                 /api/security/jobs/:jobId/approve
POST                 /api/security/jobs/:jobId/cancel
GET                  /api/security/cases
```

## Recon station integration standard

The Security workspace is becoming a complete recon station rather than a
collection of raw command wrappers. Kali package discovery and MCP tool
discovery only prove that software exists. They do not make a tool ready for a
person, workflow, or model to use.

Every discovered security tool has one of four integration states:

1. **Inventoried** — installed on a node and visible in the capability catalog.
2. **Registered** — categorized by purpose, target types, privilege, network
   behavior, and risk level.
3. **Adapted** — exposed through typed inputs and fixed argument construction,
   with timeouts, cancellation, raw evidence, and normalized output.
4. **Verified** — parser fixtures, policy tests, persistence tests, and a live
   Kali run have passed for the supported operation.

Only verified operations may be offered to General Chat or autonomous planning.
The model selects an intent and a supported operation. It never promotes an
inventoried executable into an executable model tool and never composes an
unreviewed shell command.

An adapter is complete only when it has:

- explicit target and option schemas;
- a fixed risk and approval classification;
- scope validation before dispatch;
- deterministic CLI or MCP argument construction;
- bounded concurrency, timeout, cancellation, and output limits;
- raw stdout, stderr, reports, and artifacts preserved as evidence;
- a parser that distinguishes positive results, negative results, warnings,
  rate limits, authentication failures, and partial completion;
- normalized assets, identities, services, observations, relationships, and
  confidence with provenance;
- unit fixtures for representative success, empty, partial, and failure output;
- persistence and restart recovery coverage;
- one repeatable live test on the configured Kali node;
- a non-technical UI that explains what the result establishes and what it
  cannot establish.

Interactive desktop tools, radio or hardware-dependent tools, long-running
service platforms, and exploit or credential operations remain visible in the
catalog but use assisted or restricted workflows. They are not converted into
generic autonomous commands.

### Installed Pi capability waves

The current Kali Pi inventory supports the following integration order.

**Wave 1 — recon foundation**

Adapted so far: dig, Whois, DNSRecon, DNSenum, DNSmap, Fierce, passive Amass,
DMitry, theHarvester, Sherlock, Maigret, Holehe, PhoneInfoga, WhatWeb,
Wafw00f, SSLyze, sslscan, Gobuster, FFUF, DIRB, Nikto, WPScan, Wfuzz, and
Nmap, arp-scan, fping, Ike-scan, enum4linux, smbclient, and SMBMap. The
installed `httpx` is the Python HTTP client rather than
ProjectDiscovery HTTPX, and Wapiti is blocked by a missing Python dependency.
The installed `snmpcheck` is a local system checker rather than an SNMP
enumeration utility. ExifTool, hashdeep, offline TShark analysis, and
SearchSploit are adapted with exact file or query scope. Binwalk stalls on a
tiny local file, YARA is not installed, and bulk-extractor remains blocked
until remote artifact download and cleanup are durable.
An adapted operation still needs its
repeatable authorized live fixture before it is considered verified for AI use.

- Identity and public footprint: Sherlock, Maigret, Holehe, SpiderFoot,
  recon-ng, theHarvester, and PhoneInfoga.
- Domain and internet surface: dig, Whois, DNSRecon, dnsenum, dnsmap, fierce,
  Amass, httpx, WhatWeb, Wafw00f, sslscan, and SSLyze.
- Local and authorized network discovery: Nmap, arp-scan, arping, fping,
  Netdiscover-equivalent discovery, enum4linux, smbclient, SMBMap, SNMP tools,
  and Ike-scan.
- Web discovery and configuration: Gobuster, ffuf, dirb, Nikto, WPScan,
  Wapiti, and wfuzz.

**Wave 2 — evidence and analysis**

- Packet and protocol analysis: TShark, tcpdump, tcpick, and tcpreplay.
- File and metadata analysis: ExifTool, YARA, hashdeep, Binwalk,
  bulk-extractor, Sleuth Kit, and strings/file utilities.
- TLS, certificate, and cryptographic inspection: OpenSSL, sslscan, SSLyze,
  and ssldump.
- Vulnerability correlation: SearchSploit, Nuclei when installed, and GVM
  result import. Scanner findings remain observations until corroborated.

**Wave 3 — specialized authorized assessment**

- Windows and AD assessment: Impacket, BloodHound.py, Certipy, enum4linux,
  SMBMap, and Responder with explicit lab or owned-network scope.
- Wireless, Bluetooth, and RF inventory: Kismet, Aircrack-ng, BlueZ, and
  supported capture hardware.
- Offline password auditing: John and Hashcat against user-provided material.
- Reverse engineering and firmware: Radare2, GDB, APK tooling, Binwalk,
  Flashrom, and related local-file workflows.

**Wave 4 — restricted validation**

- SQLMap, Commix, Hydra, Metasploit, MITM tooling, post-exploitation tooling,
  and other intrusive operations require a separate approved scope, explicit
  run approval, and narrowly supported adapters. They are never part of a
  default recon suite.

Identity recon needs an additional correlation layer before model handoff.
Username existence is a lead, not identity proof. BORG must collect public
display names, bios, avatars, locations, linked websites, account age, and
cross-links; compare them with confirmed identifiers; and present likely,
possible, conflicting, and rejected clusters with the evidence for each score.
PhoneInfoga is limited to normalization and public pivots. It is not presented
as a free reverse-subscriber or social-account lookup.
