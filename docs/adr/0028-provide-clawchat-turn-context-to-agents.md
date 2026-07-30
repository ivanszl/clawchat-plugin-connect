---
status: accepted
---

# Provide trusted ClawChat Turn Context to local Agents

Connect supplies each ClawChat-originated runtime turn with structured context derived from the normalized ClawChat envelope, including the exact conversation id and type, message id, sender identity, and known mentions. User-authored prompt text is kept separate from this metadata, while Client-originated turns do not claim a current ClawChat message context.

Skills may use these identifiers for conversation- and message-targeted ClawChat Tool Commands such as leaving the current group, sending mentions, and reacting to a message. When authoritative context is absent they must stop rather than infer identifiers from names or prose; process-level environment cannot carry this context because one Binding Runtime Instance may serve multiple concurrent Sessions.
