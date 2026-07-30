---
status: accepted
---

# Submit Tool Requests through owner-only local state

The `clawchat-connect` CLI persists every actual Agent-callable ClawChat Tool Command and Agent-managed Liveware operation as a Tool Request in Connect's owner-only SQLite state and waits for its result. Connect Service claims the request, validates its canonical tool name and input, executes it with the selected Agent Binding's existing authenticated HTTP or WebSocket transport or the bundled Liveware executable, and persists the outcome for the CLI.

This avoids a separate local network Gateway and prevents the CLI from reading activation credentials, calling ClawChat directly, opening a competing WebSocket, or handling a Liveware control token. Tool Requests are not exposed through Client Interface, trusted-LAN mode, or Liveware Exposure. A settled request remains as its Tool Call Record instead of being deleted; requests require explicit expiry and settlement rules so abandoned or crash-interrupted work cannot execute unexpectedly.

Each Tool Call Record keeps the request id, Agent Binding, canonical operation, secret-scrubbed normalized arguments, bounded JSON outcome or error, optional Session and Turn provenance, state and attempt information, and lifecycle timestamps. Oversized outcomes carry explicit truncation metadata. Activation credentials, authorization headers, Liveware tokens, uploaded file contents, and internal authentication responses never enter the record.

Once claimed, every Tool Request is attempted at most once. Read-only and mutating operations share the same rule: a transport failure, operation failure, timeout, process interruption, or indeterminate outcome is terminal and is never retried automatically. Reusing a request id returns the existing Tool Call Record; a deliberate retry requires a new explicit request with a new id. A pending request that has never been claimed may still receive its first attempt after Service recovery only while it remains unexpired.

Settled Tool Call Records remain for at most 90 days and at most 10,000 records per Agent Binding. Cleanup removes the oldest settled records whenever either bound is exceeded, while pending, running, and indeterminate records are never removed automatically.

Ordinary ClawChat Tool Requests use a 30-second deadline; file-transfer and Agent-managed Liveware requests use 120 seconds. Connect Service never claims an expired request. A timeout after claim settles as failed only when Connect can establish that no external effect occurred; otherwise it settles as indeterminate.

Connect provides no CLI, Agent, or Client Interface history, show, or prune surface for Tool Call Records. They exist only for request settlement, internal audit and diagnostics, and automatic retention cleanup.
