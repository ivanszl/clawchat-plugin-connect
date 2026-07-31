---
status: accepted
---

# Address group commands and interactions explicitly

Connect keeps every Runtime Interaction in its originating Turn Surface and, for ClawChat, its originating direct or group conversation. This supersedes ADR-0013 and the competing-response-route clause of ADR-0023: a group-originated Interaction is presented and settled in that group rather than redirected to the Binding Owner's direct conversation or duplicated into Connect Client.

Group text uses a leading structured mention of the activated ClawChat Agent to express command or Runtime Interaction response intent. Connect control commands use `@Agent /command` in groups and `/command` in direct conversations; textual Interaction responses use the corresponding `/approve`, `/approve session`, `/deny`, `/N`, and `/answer <text>` forms. Commands are exact, single-line, text-only inputs with strict argument grammars. Ordinary group turns may mention the Agent elsewhere, but only a leading identity-matched mention is addressing metadata and is removed from effective prompt content.

Structured Interaction responses carry exact Interaction identity and are additionally scoped to the Agent Binding and originating conversation. Text responses may act only when that conversation has one compatible pending Interaction; Connect rejects ambiguity, stale responses, invalid formats, and cross-conversation replay instead of guessing or submitting them as Runtime Turns. Group presentations reply to the originating message, show the Session Ref and sanitized Connect-owned fields, and publish accepted responders and terminal state without echoing free-text answers or exposing native payloads.

## Considered Options

- Redirect group Interactions to the Binding Owner's direct conversation. This protects decisions but separates them from the conversation that created them and makes group work appear stalled.
- Expose the same Interaction through both ClawChat and Connect Client. This adds competing response routes and weakens the rule that Turn Origin owns interaction state.
- Keep Interactions in their originating conversation. This preserves context and makes routing predictable, at the cost of requiring explicit group response and visibility rules.

## Consequences

Connect control commands remain restricted to the receiving Agent Binding's Binding Owner. As a temporary release constraint, any participant in the originating group may answer its Runtime Interactions, including granting Session-scoped approval; a later group permission model must deliberately replace that constraint. The first valid approval or current-question answer wins, successive questions may be answered by different participants, all terminal states remain terminal and visible in the group, and secret questions are never collected through ordinary ClawChat messages. Connect announces successful settlement only after the Runtime Adapter's native response transport confirms delivery; failed delivery is terminal and visible.
