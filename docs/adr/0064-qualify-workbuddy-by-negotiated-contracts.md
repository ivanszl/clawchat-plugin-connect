---
status: accepted
---

# Qualify WorkBuddy by negotiated contracts, not application versions

The official WorkBuddy Runtime Plugin keeps one Bundle with two isolated Runtime Capabilities, `workbuddy-ai` and `workbuddy-cn`. Installed application and embedded CodeBuddy versions are observed diagnostic metadata, not an authorization allowlist; every WorkBuddy Task Attachment instead fails closed unless the selected capability owns the application, sidecar, endpoint process and connected socket, ACP negotiates the supported protocol, and the loaded Task supplies a complete WorkBuddy Task Identity Proof.

A natively advertised capability is necessary but insufficient for Connect to expose it: the same capability must also pass current installed-runtime qualification for that distribution. This permits application releases to change without optimistic trust, while semantic drift fails at the exact ownership, protocol, identity, replay, or capability gate. An explicit CodeBuddy Session remains a separate target and is never a fallback from a failed WorkBuddy Task Attachment.

This supersedes the application-version and embedded-runtime allowlists in ADR-0037 and ADR-0038. It retains ADR-0038's Task Attachment boundary and ADR-0040's explicit separation between WorkBuddy Tasks and CodeBuddy Sessions.
