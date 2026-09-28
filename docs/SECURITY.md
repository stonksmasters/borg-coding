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
