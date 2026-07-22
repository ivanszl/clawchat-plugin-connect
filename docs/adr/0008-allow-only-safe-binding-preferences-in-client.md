# Allow only safe Binding preferences in Connect Client

Connect Client may update only `displayName`, `model`, `modelReasoningEffort`, and the default `outputVisibility`. Binding identity, Runtime Adapter kind, ClawChat activation, executable and environment overrides, sandbox and approval policy, network and web-search access, Git checks, and additional directories remain CLI-owned. Connect Service validates this boundary server-side; the Client cannot expand it by submitting arbitrary config keys.

All allowed preferences take effect immediately. If a turn is active, saving succeeds without cancelling it and the new preference applies to the next turn. For runtime turn options such as model and reasoning effort, Connect preserves the Runtime Thread ID, releases the in-memory Runtime Adapter session after the active turn, and resumes that same Thread with the new options rather than invalidating conversation context.
