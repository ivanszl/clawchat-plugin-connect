---
status: accepted
---

# Separate Session turn scheduling, execution, and surfaces

Connect will separate accepted-turn targeting, scheduling, execution, and delivery into distinct deep modules. Session Continuity captures an immutable Turn Target before enqueue; Session Queue orders work without executing it; Session Turn Executor owns Runtime Adapter handle start, resume, cache, prompt, cancellation, close, and invalidation; Connect Client and ClawChat satisfy an internal Turn Surface seam for their different input, Runtime Interaction, failure, visibility, media, and delivery behavior.

Every displayable Runtime Activity is committed to the Connect Transcript Projection before its Turn Surface attempts delivery. Session Continuity may request release or invalidation of an in-memory runtime handle through a small internal seam, while Session Turn Executor reports newly created Runtime Thread identity back through Session Continuity instead of writing persistence directly. This keeps Session Intent and identity rules out of execution, queue policy out of prompt handling, and surface-specific branches out of the shared turn implementation.

Session lifecycle uses that seam as an acquire/release capability: Runtime orchestration claims the Session queue,
drains and cancels active execution, and releases the handle; Session Continuity keeps ownership of validation,
journaling, native mutation, and the local commit while the claim is held. The lifecycle operation itself is not
tunneled through Runtime orchestration.

This decision preserves existing Turn Origin behavior and input-projection timing while replacing the current combined `ConnectRuntime` orchestration shape. It refines ADR-0013 without allowing Client-originated output to reach ClawChat or treating the current Web implementation as a separate Turn Origin.
