---
status: accepted
---

# Route Runtime Interactions by Turn Origin

Connect routes approvals and structured user-input requests exclusively to their Turn Origin. A Client-originated interaction is exposed only to Connect Client. A ClawChat-originated interaction is exposed only to the Agent Binding owner in the owner's direct ClawChat conversation, including when the turn originated in a group. The inactive surface must not display or resolve the request.

Connect owns the interaction ID, pending/submitting/resolved/expired state, authorization, and routing. Runtime Adapters expose Connect-owned interaction requests and accept Connect-owned responses while keeping app-server, ACP, or other native request IDs private. Connect Client interactions use the persisted Client coordinator. ClawChat interactions use owner-authorized plain-text commands: `/approve`, `/approve session`, and `/deny` settle approvals, numbered replies such as `/1` and `/2` select question options, and a free-text question consumes the owner's next direct reply. Each route validates and atomically claims its own pending interaction before forwarding it to the Adapter.

Client-originated Runtime Interactions and their resolution are written to the Connect Transcript Projection and are not hidden by `outputVisibility`. ClawChat-originated interactions remain on ClawChat and do not create a pending Web card. If the underlying turn or runtime process ends before settlement, Connect expires the interaction instead of accepting or replaying a response.

A browser tab or live stream subscription does not own a Runtime Interaction. If Connect Client disconnects or reloads during a Client-originated turn, its interaction remains pending in Connect Service and is returned from the persisted Session snapshot when an authorized Client reconnects; it is never redirected to ClawChat. It remains pending until answered or explicitly cancelled, or until the underlying turn, Adapter connection, or app-server process ends and causes it to expire.

Codex Agent Bindings default to the `on-request` approval policy so a Runtime Interaction can reach Connect Client without requiring a hidden bootstrap setting. Operators may explicitly select `never` or `untrusted` through the CLI. Loading an older Binding with no stored approval policy normalizes it to `on-request`; Connect still requires an explicit human response before granting any requested command or file-change escalation.
