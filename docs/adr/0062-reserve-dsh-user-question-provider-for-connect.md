---
status: superseded by ADR-0063
---

# Reserve the DSH user-question provider for Connect

A Connect-owned DSH process must register the Bridge as the process's sole `userQuestions` provider and reject a selected Profile that already occupies that slot. The current DSH seam permits one provider per process, and a native question request carries the Agent, questions, and cancellation signal but not the Turn Origin; a published-runtime probe proved that a Connect-originated `ask_user_question` call renders in DSH Web when the Web provider owns the slot. Connect will not replace or multiplex DSH's official Web provider through private state; same-process native Web and ClawChat question routing requires an upstream DSH multiplexing or attach contract.

## Consequences

Profiles that compose the DSH Web question provider are incompatible with Connect Runtime Interaction routing and fail activation explicitly rather than sending a ClawChat-originated question to the wrong surface. This decision does not disable the native user-question service or model-facing tool: the selected Profile supplies those capabilities, while the Bridge owns human answer collection for the Connect process.
