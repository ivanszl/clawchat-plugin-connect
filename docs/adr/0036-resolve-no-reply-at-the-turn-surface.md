---
status: accepted
---

# Resolve no-reply at the ClawChat Turn Surface

For group-originated Turns, Connect treats `<clawchat:no-reply/>` and its recognized compatibility forms as a terminal Turn-level veto rather than an ordinary output fragment; direct-message delivery remains unchanged. The ClawChat Turn Surface first applies the effective output-visibility policy, retains ordinary candidate deliveries until the runtime finishes, and then either publishes them or discards their textual and Runtime Activity output when the terminal Agent response carries a No-Reply Signal; every Runtime Activity remains available in the Connect Transcript Projection. Explicit media remains deliverable with the marker removed from its caption, matching the intent to avoid a duplicate ordinary reply without swallowing an intentional artifact. Required control output remains immediate because delaying an approval, structured question, or control failure can block the Runtime Turn and cannot be undone by a later signal. A trusted group-response protocol teaches the Agent when to choose the signal, while deterministic Connect code—not a second model classifier—enforces suppression so earlier thinking, progress, or streamed assistant states cannot leak before the final decision.
