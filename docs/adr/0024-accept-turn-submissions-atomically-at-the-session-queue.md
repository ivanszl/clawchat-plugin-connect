---
status: accepted
---

# Accept Turn Submissions atomically at the Session Queue

A Connect Client prompt and all of its attachments form one Turn Submission. Connect will stage attachments in Connect-owned storage, validate the effective Turn Submission Capability, and accept the submission only when its immutable Turn Target enters the Session Queue. Before that acceptance point, failure or cancellation rolls back the entire submission and removes all staged media; after it, the media belongs to the accepted Turn and later Runtime execution failure is reported as Runtime Activity rather than reopening the Client draft.

The effective capability is the intersection of the Runtime Adapter's native input capability and the submitting Turn Surface's delivery constraints. Connect Client consumes that presentation model and may provide progress and cancellation, but it does not define attachment limits or orchestrate separate media-upload and Turn commands.

This rejects uploading attachments to remote media storage before Turn acceptance when that storage has no prepare/rollback, lease, expiry, or delete semantics. Such an integration cannot claim atomic Turn Submission support; it must instead consume Connect-owned staging or provide a Runtime Adapter preparation mechanism with real rollback.
