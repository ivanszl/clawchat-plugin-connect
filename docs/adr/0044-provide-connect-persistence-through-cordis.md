---
status: accepted
---

# Provide Connect persistence through an internal Cordis service

Connect Core defines an abstract Cordis persistence service, and the official SQLite Provider owns its database, schema, migrations, initialization, and disposal behind that service. Startup always mounts this Provider from Connect-owned SQLite configuration rather than resolving a `pluginId` or capability; the same implementation is file-backed in production and uses `:memory:` in tests. This follows DeepSeek Harness's provider pattern while retaining Connect-specific state semantics, but the contract is not yet exposed as a third-party Plugin Bundle capability because Connect has no proven second backend and its cross-domain transactions, migration compatibility, bootstrap dependency, and access to all Connect Durable State would prematurely freeze a broad fully trusted SDK surface.
