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

## First provider: TypeScript / JavaScript

The initial provider uses the TypeScript Language Service directly. It supports TypeScript, TSX, JavaScript, JSX, MJS, CJS, MTS, and CTS projects and reads the repository's `tsconfig.json` or `jsconfig.json` when available.

Capabilities include workspace symbol search, per-file outlines, go-to-definition, references, implementations, quick symbol information, and syntactic/semantic/suggestion diagnostics.

For TypeScript and JavaScript, `repository_file_graph` reports direct imports and importers. `repository_call_hierarchy` reports incoming and outgoing calls with source locations. `repository_change_impact` reports direct and transitive importers and, when given a symbol position, references to that symbol. The impact result is a bounded static estimate: it does not infer runtime behavior, dynamic imports, or test coverage. Large results declare truncation. These three graph tools currently reject non-TypeScript/JavaScript files explicitly; the existing Python, Rust, Go, and C# navigation tools remain available.

The provider contract remains language-neutral so Python, Rust, Go, C#, and other language backends can be added later without changing the ToolBroker contract.

## Design rules

- Language intelligence is read-only.
- Filesystem mutation remains worktree-scoped and explicit.
- Results use repository-relative paths.
- The language service must never broaden the repository access policy.
- Structural navigation supplements literal search; it does not replace it.
- Root `npm test` contains the canonical integration and access-boundary coverage.
