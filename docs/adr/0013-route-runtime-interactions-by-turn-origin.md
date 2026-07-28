---
status: accepted
---

# Route Runtime Interactions by Turn Origin

Connect routes approvals and structured user-input requests as Runtime Interactions according to their Turn Origin. A Client-originated interaction is exposed only to Connect Client; a ClawChat-originated interaction is exposed both to Connect Client and to the Agent Binding owner in ClawChat, using the owner's direct conversation when the turn originated in a group. This preserves the rule that Client-local turns are not published to ClawChat while still allowing Client to supervise remotely initiated work.

Connect owns the interaction ID, pending/submitting/resolved/expired state, authorization, and routing. Runtime Adapters expose Connect-owned interaction requests and accept Connect-owned responses while keeping app-server, ACP, or other native request IDs private. A single coordinator validates a response and atomically claims a pending interaction before forwarding it to the Adapter; the first valid response wins, later responses receive the settled result, and all surfaces that received the interaction observe one shared resolution.

Runtime Interactions and their resolution are always written to the Connect Transcript Projection and are not hidden by `outputVisibility`. If the underlying turn or runtime process ends before settlement, Connect expires the interaction instead of accepting or replaying a response. Existing `requiredControl` text routing is insufficient and must be replaced by this structured interaction seam rather than extended independently for each surface.

A browser tab or live stream subscription does not own a Runtime Interaction. If Connect Client disconnects or reloads during a Client-originated turn, its interaction remains pending in Connect Service and is returned from the persisted Session snapshot when an authorized Client reconnects; it is never redirected to ClawChat. It remains pending until answered or explicitly cancelled, or until the underlying turn, Adapter connection, or app-server process ends and causes it to expire.

Codex Agent Bindings default to the `on-request` approval policy so a Runtime Interaction can reach Connect Client without requiring a hidden bootstrap setting. Operators may explicitly select `never` or `untrusted` through the CLI. Loading an older Binding with no stored approval policy normalizes it to `on-request`; Connect still requires an explicit human response before granting any requested command or file-change escalation.
