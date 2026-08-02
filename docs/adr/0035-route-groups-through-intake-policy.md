---
status: accepted
---

# Route groups through their per-conversation intake policy

Connect applies the ClawChat group settings selected for each Agent Binding and conversation before creating Runtime Turns: mute suppresses dispatch, mention-only requires a structured mention of the activated Agent, and eligible messages are coalesced using the selected activity delay. A message that mentions the activated Agent first joins its conversation's pending Batch and then causes that entire Batch to submit immediately in original order. An ordinary mention-only Turn also receives up to ten recent group messages as read-only context because those messages never entered the Runtime; delayed Batch Turns and group control commands do not receive this additional history. The settings are read-only to Connect; a content-free WebSocket change notification triggers a bounded group-only refresh, while failures preserve the last trusted complete Snapshot and an unknown group defaults to mention-only. Muted messages are still received and deduplicated but never create a deferred backlog; enabling mute discards a pending Batch, disabling it affects only new arrivals, and policy is checked again at Batch submission. This supersedes ADR-0033 only where it required every ordinary group Runtime Turn to carry an Agent mention; ADR-0033 continues to govern the stronger leading-mention rules for group control commands and Runtime Interaction responses. Aligning with the ClawChat policy lets the group owner choose participation frequency while preserving explicit addressing for privileged or ambiguous inputs.

The last authoritative Snapshot is persisted in Connect's state database with every setting scoped by Agent Binding and ClawChat conversation, never by Project or as an installation-wide group setting. Reconnect and change notifications still trigger an authoritative full refresh for that Binding; a notification marks its persisted Snapshot stale, and a failed refresh then falls back to mention-only rather than routing through stale `all`. An authoritative empty Snapshot clears only that Binding's rows, while a non-authoritative fetch never erases them.

A successful refresh takes effect without restarting Connect and reconciles pending Batches immediately. A new mute discards the Batch; mention-only discards a Batch with no Agent Mention; a changed activity delay recomputes idle and maximum deadlines from the constituent messages' original times and submits immediately when the new deadline has passed; zero delay submits the existing Batch immediately and makes subsequent messages independent Turns. Relaxing mute or mention-only affects only new arrivals and never resurrects discarded input.

Recognized group control commands remain outside ordinary Batch content. Session- or runtime-selection mutations first submit an existing Batch and then execute in conversation order so older messages cannot cross the new boundary; inspection, output-visibility, and cancellation commands remain immediate and leave the pending Batch unchanged.

The final message in a submitted Batch is the reply and Runtime Interaction anchor in ClawChat, while every constituent message retains its own identity, sender, structured mentions, order, and attachments in the Agent-visible Turn context.

Batch capacity is bounded to 64,000 rendered characters and ten attachments. Connect splits only between intact messages—submitting the current Batch before adding an over-limit next message—and reports an individually invalid message instead of truncating or silently dropping it.

An unsubmitted Batch is recoverable from Connect's durable inbound-message records rather than owned only by in-memory timers. Restart recovery preserves message order and original idle/maximum deadlines, immediately submits an already-expired Batch after settings resolution, rechecks policy and capacity, and marks constituent messages handled only after the Runtime accepts the reconstructed Turn.

A zero-second activity delay bypasses batching completely: each eligible message becomes an independent Runtime Turn immediately and relies only on the existing Session Queue for ordering.
