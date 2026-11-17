# Streaming Tech Sentry MCP development

This TypeScript service wraps the pinned official Sentry toolkit with Streamable HTTP and self-hosted compatibility handling. `server.ts` starts the service; `src/app.ts` creates the runtime and MCP sessions. `src/upstream-adapter.ts` integrates upstream tools, `src/tools/` supplies wrapper tools, `src/compatibility/` handles API differences, and `src/security/` validates paths and redacts credentials. See [README.md](README.md) for setup and [docs/tools.md](docs/tools.md) for tool contracts.

Use Docker from the repository root:

```bash
docker build --target test -t sentry-mcp:test .
docker build --target runtime -t ghcr.io/streaming-tech/sentry-mcp:latest .
```

The test target runs TypeScript, Biome and Vitest checks, including tests as the non-root runtime user. The runtime target checks types and imports the application as that user.

Follow strict TypeScript and the existing Biome configuration: two-space indentation, double quotes and semicolons as needed. Add focused Vitest coverage for changed behaviour and keep compatibility fixtures with API adaptations. Use locked dependencies and the pinned upstream source. Make focused changes and preserve unrelated work.

Before publishing a branch or PR, review every proposed commit for code quality and plain language, including identifiers, comments, documentation, test names and commit messages. Describe the actual operation or behaviour and remove vague claims and unnecessary terminology. Keep PR descriptions brief and focused on the problem and solution.

Keep advertised tools and execution checks consistent with discovered token permissions. Preserve per-tool write permissions, same-origin access, organisation/project restrictions and request limits. Organisation-wide writes are hidden in project-constrained sessions. Generic API tools remain read-only. Keep credentials out of logs and responses.
