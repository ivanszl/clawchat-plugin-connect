---
status: accepted
---

# Publish Connect Client through a managed Liveware Exposure

Connect may optionally publish its existing Connect Client through one Connect-managed Liveware App while retaining its local loopback and trusted-LAN entrypoints. Liveware's `public` or `private` policy is the only remote-entry authorization: Connect adds no remote roles or per-user capability filters, and every admitted user receives the complete installation-wide Client capability set. This is the authenticated remote design left outside ADR-0016 rather than an expansion of unauthenticated LAN mode.

One Connect Owner is shared by every activated Agent Binding. Connect provisions the App in the Liveware Control Plane, configures its policy and tunnel binding, registers the App separately with ClawChat through `POST /v1/agents/me/liveware`, and coordinates the bundled, pinned `liveware` companion process. Liveware App creation alone does not make a ClawChat launcher entry. Replacing the Connect Owner preserves existing local Projects, Sessions, and Runtime Threads, unregisters and retires the previous owner's App, and creates and registers a new App for the new owner with the same policy; the public URL may change.

ADR-0034 supersedes the singleton-owner, singleton-App, and installation-wide capability clauses. The managed publication mechanism and browser transport decisions remain in force.

Connect uses its activated ClawChat Agent token for Liveware Control Plane login and ClawChat Liveware registration. It does not acquire or persist the human user's ClawChat token: ClawChat injects that token into the WebView and Liveware exchanges it for its own ticket when the user opens the App.

The integration treats Liveware as an unmodified external executable. Connect absorbs compatibility requirements at its own Client Interface and process boundary rather than requiring Connect-specific changes to the Liveware source or tunnel protocol.

Connect Client keeps its existing same-origin HTTP snapshot/command and SSE event transport; Liveware Exposure does not add long polling or replace that browser protocol with WebSocket. The existing Client Interface Host and Origin rules also remain unchanged. Any Liveware-specific forwarding adaptation belongs to a separate additive exposure boundary rather than the Client Interface, and must not enable generic reverse-proxy trust, wildcard external Origins, or arbitrary forwarded-header interpretation.
