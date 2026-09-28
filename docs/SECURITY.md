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
