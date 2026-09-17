# Language intelligence

BORG's language-intelligence layer gives the canonical agent structural code navigation that is richer than filename ranking or literal search.

## Canonical integration

Language intelligence is exposed through `packages/tools/src/tool-broker.ts`, alongside the existing approved repository inspection tools. It is not driven by a separate orchestrator or package-level runtime.

The ToolBroker creates the provider for the currently approved repository and passes every candidate source path through `AccessController`. Excluded directories, symlink escapes, and secret-like paths therefore stay outside both ordinary repository reads and the language-service index.

Available read-only tools are:

- `repository_symbols`
- `repository_file_symbols`
- `repository_definition`
- `repository_references`
- `repository_implementations`
- `repository_symbol_info`
- `repository_diagnostics`
- `repository_file_graph`
- `repository_call_hierarchy`
- `repository_change_impact`

These tools are available in PLAN, EDIT, and AGENT modes when a repository has been explicitly approved. ASK mode does not expose repository content.

## Providers and structural graph

The built-in provider uses the TypeScript Language Service directly. It supports TypeScript, TSX, JavaScript, JSX, MJS, CJS, MTS, and CTS projects and reads the repository's `tsconfig.json` or `jsconfig.json` when available. Bounded LSP adapters provide the same navigation contract for Python, Rust, Go, and C#.

Capabilities include workspace symbol search, per-file outlines, go-to-definition, references, implementations, quick symbol information, and syntactic/semantic/suggestion diagnostics.

For every supported language, `repository_file_graph` reports direct workspace dependencies and dependents. TypeScript/JavaScript uses compiler module resolution; Python, Rust, Go, and C# use bounded language-specific import/module/namespace resolution over approved workspace files. `repository_call_hierarchy` uses the provider's language-server call-hierarchy protocol and reports incoming and outgoing calls with source locations. `repository_change_impact` combines the reverse dependency graph with language-server definitions and references when a symbol position is supplied.

Graph and impact results are static evidence, not guarantees of runtime behavior, dynamic loading, reflection, generated code, route reachability, or test coverage. Scans stop at 500 source files, dependent traversal stops at 200 files, symbol results are bounded, and the result declares truncation when a limit is reached. File dependency graphs remain available when an external language server is absent; symbol navigation and call hierarchy report the missing provider explicitly.

The provider-neutral graph contract keeps the ToolBroker independent of compiler and language-server details, so additional languages can be added without changing agent tool schemas.

## Design rules

- Language intelligence is read-only.
- Filesystem mutation remains worktree-scoped and explicit.
- Results use repository-relative paths.
- The language service must never broaden the repository access policy.
- Structural navigation supplements literal search; it does not replace it.
- Root `npm test` contains the canonical integration and access-boundary coverage.
