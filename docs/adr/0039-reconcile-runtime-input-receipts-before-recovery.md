---
status: accepted
---

# Reconcile Runtime input receipts before inbound recovery

A Runtime may durably accept a ClawChat Turn immediately before Connect crashes and commits the inbound handled marker. Connect therefore embeds a canonical content digest beside every actionable and consumed-context message identity in its structured Runtime prompt, and each Runtime Adapter exposes an authoritative input-receipt scan with `accepted`, `absent`, or `unknown` semantics. Recovery may submit an inbound message again only after every candidate Runtime Thread proves that the exact message ID and digest are absent; an accepted receipt atomically handles every matching Batch/context member, while incomplete, legacy, malformed, or failed native history remains pending and is retried with bounded backoff. This trades additional native-history reads and conservative waiting for protection against duplicate Runtime side effects and duplicate ClawChat replies without treating visible transcript text as identity.
