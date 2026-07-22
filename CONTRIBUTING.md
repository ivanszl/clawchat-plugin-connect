# Contributing

ClawChat Connect is currently alpha software. Before opening a pull request:

1. Install the pinned Bun version from `package.json` and run `bun install --frozen-lockfile`.
2. Read `CONTEXT.md` and the relevant records under `docs/adr/` before changing domain or runtime behavior.
3. Add regression tests at the owning module boundary.
4. Run `bun run check` and `bun run clean && bun run build`.

Use the terminology in `CONTEXT.md`. Runtime-native details belong behind a Runtime Adapter; Protocol v2 details belong in the transport and protocol modules. Do not commit generated `dist/` output, local SQLite state, credentials, or captured private conversations.

Security-sensitive reports should follow `SECURITY.md` rather than a public issue.
