# Execution Observability

Last updated: 2026-09-19

## Goal

The user should never have to guess whether BORG is thinking, reading, editing, verifying, repairing, stuck, waiting for approval, or finished.

BORG should expose useful execution state without dumping raw internal reasoning.

## Primary status model

The server now derives a single normalized `RunView` from persisted task/workflow state and task events. The website workspace renders that object instead of maintaining a second client-side progress state.

At all times, the workspace shows:

- project;
- active phase;
- active slice or scoped entity;
- current execution stage;
- active role when relevant;
- current action summary;
- latest evidence;
- blocking issue if any;
- next expected transition.

Examples of execution stages:

- planning;
- awaiting approval;
- preparing context;
- implementing;
- starting preview;
- verifying;
- reviewing design;
- repairing;
- documenting;
- handing off;
- awaiting frontend review;
- preparing backend phase;
- complete;
- blocked.

## Activity feed

BORG should emit structured, user-readable events for meaningful actions.

Useful events include:

- plan created or revised;
- plan approved;
- slice selected;
- context compiled;
- files inspected;
- files changed;
- command started and completed;
- preview started or refreshed;
- browser verification started and completed;
- screenshot captured;
- review finding opened;
- repair started;
- finding verified fixed;
- handoff persisted;
- slice completed;
- phase completed;
- task blocked.

The UI may summarize low-level repetitive events.

## What not to expose

The product should not require raw private chain-of-thought to be understandable.

The user needs:

- action;
- rationale at an operational level;
- affected scope;
- evidence;
- result.

For example:

"Checking Product Detail at mobile width because this slice requires responsive purchase controls."

That is useful.

A token-by-token hidden reasoning trace is not required.

## Preview behavior

Preview is a primary product surface.

It should:

- maintain its own scroll position;
- not constantly refresh when no relevant files changed;
- show when a refresh is pending or happened;
- recover after preview-process failure;
- expose the active URL and basic health;
- synchronize with the selected page or component when scoped workspaces exist.

## Failure transparency

When something fails, BORG should show:

- what failed;
- which acceptance criterion or execution step is affected;
- evidence;
- whether automatic repair will run;
- how many repair attempts have occurred;
- when user input is actually required.

Generic states such as "RESTORED" should never replace the real durable task state.

## Context transparency

The Context Compiler records exact model inputs and provenance manifests. These remain in the Advanced execution inspector rather than the primary product surface.

The diagnostic view can show what categories of information were included:

- project decisions;
- current slice;
- relevant files;
- handoff;
- recent evidence;
- operating rules.

This is a diagnostic view, not a raw model prompt dump.

It helps identify context-bloat and stale-context failures.

## Structured source of truth

Status chips and progress indicators must come from server-owned persisted state and events.

They should not be inferred from assistant prose.

If the assistant says "complete" while verification is still failing, the UI must continue to show the task as not complete.

## History

A project should retain enough execution history to answer:

- what changed;
- why it changed;
- who or what role changed it;
- what evidence passed;
- what findings remain;
- what was handed to the next slice.

History is inspectable without turning the main interface into a terminal log viewer. The primary website surface is Preview / Plan / Changes / Evidence; low-level activity, model-context records, project memory, checkpoints, and process logs are advanced diagnostics.

## Success criteria

Execution observability is working when a user can glance at BORG during a long build and correctly answer:

- where are we;
- what is it doing;
- why is it doing that;
- did it work;
- what happens next.


## Canonical workflow event stream

Raw task telemetry is normalized in Core before presentation. `GET /api/tasks/:taskId/workflow-events` returns stable `WorkflowEvent` records with:

- project/task identity and workflow version;
- category and stable kind;
- status;
- title/detail;
- timestamp;
- raw `sourceType` and payload provenance.

The run-status projection uses the same normalized event model. UI code should not derive lifecycle truth from arbitrary raw event names. Durable workflow, verification, and recovery fields remain the authority; canonical events explain what changed.
