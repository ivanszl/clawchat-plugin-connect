---
status: accepted
---

# Let TanStack Virtual own transcript scrolling

Connect Client will use TanStack Virtual as the sole scroll, end-anchoring, older-history prepend, streaming-growth, and restoration engine for the Client Transcript. Complete coding transcripts can contain thousands of dynamically sized message, Markdown, command, tool, and diff blocks, while Astryx `ChatMessageList` is presentational and does not virtualize and `ChatLayout` always installs its own stream-scroll and new-message observers. Combining those behaviors on one scroll container would create competing anchoring and resize decisions.

Connect therefore owns a `TranscriptViewport` that renders Astryx message, Markdown, code, tool, composer, and visual primitives inside stable-keyed virtual rows. It does not wrap the viewport in Astryx `ChatLayout`; the composer dock and jump-to-latest control are driven by the virtualizer. Entering or refreshing a Session anchors at the latest block, and every append or revision of that latest block follows it even when the user previously scrolled away from the end. Older pages still prepend in chronological DOM order without triggering that latest-block follow behavior. Session-specific measurement state remains bounded Client UI state rather than persisted Session data.

A collapsed subagent transcript is one measured virtual row. Expanding it renders the nested display blocks inside that row and relies on the row measurement observer to update its size; a second competing scroll container or nested virtualizer is not introduced.
