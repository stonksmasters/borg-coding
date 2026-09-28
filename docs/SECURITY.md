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
