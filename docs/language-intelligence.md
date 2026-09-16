# Language intelligence

BORG's language intelligence layer gives the agent structural code navigation that is richer than filename ranking or ripgrep.

## First provider: TypeScript / JavaScript

The initial provider uses the TypeScript Language Service directly. It supports TypeScript, TSX, JavaScript, JSX, MJS and CJS projects and reads the repository's nearest `tsconfig.json`/`jsconfig.json` when available.

Capabilities:

- workspace symbol search
- go to definition
- find references
- find implementations
- file diagnostics
- quick symbol details
- task context enrichment using symbols mentioned in the user's request

The package exposes provider-neutral result types so Python, Rust, Go, C#, and other language backends can be added later without changing the agent contract.

## Design rules

- Language intelligence is read-only.
- Filesystem edits remain explicit BORG tools.
- Results use workspace-relative paths whenever possible.
- Generated files and dependency directories are excluded from workspace symbol results when practical.
- Symbol intelligence supplements repository indexing; it does not replace textual search.
