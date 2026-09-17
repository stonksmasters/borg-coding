# Alpha 0.3 polyglot language intelligence

BORG uses one provider-neutral, read-only language-intelligence contract for symbol search, file outlines, definitions, references, implementations, hover information, and diagnostics.

## Providers

| Language | Provider | Default command |
| --- | --- | --- |
| TypeScript / JavaScript | TypeScript Language Service | built in |
| Python | Pyright | `pyright-langserver --stdio` |
| Rust | rust-analyzer | `rust-analyzer` |
| Go | gopls | `gopls serve` |
| C# | csharp-ls | `csharp-ls` |

External language servers are discovered on `PATH`; BORG never installs or downloads them. A trusted host may set `BORG_PYRIGHT_LANGSERVER_PATH`, `BORG_RUST_ANALYZER_PATH`, `BORG_GOPLS_PATH`, or `BORG_CSHARP_LS_PATH` to an executable path.

All five providers implement the same read-only graph surface. File graphs and change-impact traversal use bounded workspace dependency resolution; call hierarchy and symbol references use the language server. Python resolves local modules and packages, Rust resolves workspace `mod` and `use` targets, Go resolves packages beneath the `go.mod` module path, and C# resolves workspace namespaces. These are conservative static estimates and do not claim runtime reachability.

A repository may only enable or disable known providers:

```json
{
  "version": 1,
  "providers": {
    "python": { "enabled": true },
    "rust": { "enabled": false }
  }
}
```

Save that file as `.localcode/language-servers.json`. Repository configuration cannot provide executable names, arguments, environment variables, or initialization payloads.

## Safety and resource boundaries

- Servers run as direct child processes with no shell.
- Requests have bounded timeouts and message sizes.
- Source reads are limited to regular approved repository files up to 1 MB.
- Workspace discovery skips symlinks, generated output, dependency directories, and BORG metadata.
- Every returned `file:` URI is resolved and checked against the approved repository and access policy.
- Non-file and out-of-repository locations are discarded.
- Project-wide diagnostics inspect at most 200 files and return at most 300 results.
- Dependency scans inspect at most 500 approved source files and change-impact traversal returns at most 200 dependents.
- Server processes are shut down when the provider service closes.

The provider status is available through `repository_language_status`, `GET /api/language-intelligence`, and the workspace Tools panel. A missing or disabled server is reported explicitly; BORG does not substitute guessed analysis.
