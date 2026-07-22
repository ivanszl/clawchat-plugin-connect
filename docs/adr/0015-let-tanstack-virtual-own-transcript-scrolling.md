---
status: accepted
---

# Let TanStack Virtual own transcript scrolling

Connect Client will use TanStack Virtual as the sole scroll, end-anchoring, older-history prepend, streaming-growth, and restoration engine for the Client Transcript. Complete coding transcripts can contain thousands of dynamically sized message, Markdown, command, tool, and diff blocks, while Astryx `ChatMessageList` is presentational and does not virtualize and `ChatLayout` always installs its own stream-scroll and new-message observers. Combining those behaviors on one scroll container would create competing anchoring and resize decisions.

Connect therefore owns a `TranscriptViewport` that renders Astryx message, Markdown, code, tool, composer, and visual primitives inside stable-keyed virtual rows. It does not wrap the viewport in Astryx `ChatLayout`; the composer dock and jump-to-latest control are driven by the virtualizer. Older pages prepend in chronological DOM order, live output follows only when the user is already at the end, and Session-specific measurement/scroll snapshots are bounded Client UI state rather than persisted Session data.

A collapsed subagent transcript is one measured virtual row. Expanding it renders the nested display blocks inside that row and relies on the row measurement observer to update its size; a second competing scroll container or nested virtualizer is not introduced.
