---
status: accepted
---

# Generate Agent tool surfaces from one Tool Catalog

Connect defines the first release's 24 Agent-callable ClawChat operations once in a TypeScript Tool Catalog containing canonical name, description, JSON Schema, timeout and execution classification, secret-redaction metadata, and handler. CLI input validation and routing, `tool list` and `tool describe`, and the installed skill reference all consume this catalog.

`clawchat-core` keeps workflow selection and safety rules in `SKILL.md`, while its detailed tool index and schemas are generated under `references/`. CI regenerates that reference and rejects any diff, preventing the manifest/schema/documentation drift observed in the upstream Hermes sources.
