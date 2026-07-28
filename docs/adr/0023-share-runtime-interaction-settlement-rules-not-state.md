---
status: accepted
---

# Share Runtime Interaction settlement rules, not state

Connect Client-originated and ClawChat-originated Runtime Interactions will use the same settlement kernel implementation but independent Turn Surface instances and pending state. Response ingress adapters own authentication, authorization, and transport decoding; the kernel owns semantic response validation, deadlines, auto-resolution, abort handling, and one atomic first-valid-response claim. A ClawChat-originated Interaction's authorized Client and ClawChat response routes compete for that same origin-specific claim, while no response or fallback crosses Turn Origin.

Settlement is a two-phase process: a valid response first moves from pending to an internal claimed state, and becomes resolved only after the Runtime Adapter confirms delivery to the native request. Native delivery failure ends the Interaction as failed or expired and never silently reopens it. Manual responses and auto-resolution compete through the same claim; abort expires only an unclaimed request, and all final states are terminal.

The claimed state remains internal so this architecture change does not expand the Client Interface contract. Settlement state survives Connect Client disconnect because the active runtime process owns it, but it does not resume after the Connect process, Runtime Adapter connection, native request, or turn ends; persisted presentation is then marked expired rather than treated as a resumable request. This refines ADR-0013 while preserving Turn Origin routing.
