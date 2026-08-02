# Design QA

## Evidence

- Source visual truth: `.scratch/astryx-component-audit/02-chat-tokenized-command-reference.png`
- Product bug references: `.scratch/astryx-component-fix/liveware-regression-qa/05-typeahead-width-fail.png`, `.scratch/astryx-component-fix/liveware-regression-qa/13-collapsed-sidebar-overflow-fail.png`, `.scratch/astryx-component-fix/liveware-regression-qa/09-after-refresh-single-dollar-skill.png`
- Rendered implementation: `.scratch/astryx-component-fix/liveware-regression-qa/15-qa3-typeahead-width.png`, `.scratch/astryx-component-fix/liveware-regression-qa/16-qa3-sidebar-collapsed.png`, `.scratch/astryx-component-fix/liveware-regression-qa/17-qa3-sidebar-expanded.png`, `.scratch/astryx-component-fix/liveware-regression-qa/21-qa3-skill-before-refresh.png`, `.scratch/astryx-component-fix/liveware-regression-qa/22-qa3-skill-after-refresh.png`
- Same-input full comparison: `.scratch/astryx-component-fix/liveware-regression-qa/design-qa-comparison.png`
- Same-input focused token comparison: `.scratch/astryx-component-fix/liveware-regression-qa/design-qa-focused.png`
- Runtime surface: ClawChat desktop Liveware WebView, Session `LIVEWARE-REGRESSION-QA3-20260802` (`CUZTH37P`)
- Implementation viewport and pixels: 924 × 768 CSS px and 924 × 768 captured pixels, density 1
- Source pixels: 1638 × 970. This is a dark-theme Astryx Chat component reference, not a full-page clone target, so it was normalized by fitting into a 924 × 768 comparison cell without judging full-page color or frame parity.
- Comparison canvas: 1848 × 1536 pixels; focused comparison: 1848 × 768 pixels
- State: selected `/skill` token, open Skill Typeahead, collapsed and expanded SideNav, completed Agent output, and post-refresh transcript

## Findings

- No actionable P0, P1, or P2 visual mismatch remains in the requested surfaces.
- [P3] Long Skill descriptions can expose an internal horizontal scrollbar in the Astryx Typeahead.
  - Location: open Skill Typeahead in `SessionComposer`.
  - Evidence: the popover itself now matches the composer width, but long description rows can scroll horizontally.
  - Impact: minor scan/polish issue; selection, layout containment, and persistent controls remain usable.
  - Follow-up: prefer a future Astryx `TypeaheadItem` wrapping/truncation prop when one is available rather than adding a custom list implementation.

## Required Fidelity Surfaces

- Fonts and typography: Figtree hierarchy remains consistent across navigation, transcript, token, and composer. The token label is legible at compact UI size; no clipping or broken wrapping affects the requested controls.
- Spacing and layout rhythm: Typeahead boundaries align with the composer instead of the viewport. Collapsed SideNav is a clean rail with a centered `+` and bottom expand control; search and TreeList no longer consume collapsed width.
- Colors and tokens: Astryx semantic surfaces and the purple selected-command token remain intact before and after refresh. Status colors continue to use Astryx tokens.
- Image quality and asset fidelity: no target imagery was replaced or synthesized. Existing Astryx/Lucide icons remain sharp at the captured density.
- Copy and content: `/clawchat-browser-qa` remains authored with `/`, occurs once after refresh, and preserves token highlighting. Queue labels distinguish `正在提交` from `等待当前任务完成后发送`.
- Responsiveness and states: collapsed/expanded navigation, open Typeahead, optimistic queue, edit/delete, completed loading, and hard-refresh restoration were exercised in the real Liveware WebView.
- Accessibility: semantic button, listbox, combobox, tree, and navigation roles remained observable in automated checks; controls were reachable during the tested states.

## Full-view Comparison

The combined comparison shows the Astryx tokenized-command behavior beside the installed Liveware implementation, plus the open composer-width Typeahead and collapsed SideNav rail. The implementation intentionally uses ClawChat's light theme and full application frame, so theme and page composition are not treated as source mismatches. The requested component behavior and hierarchy match the design-system intent.

## Focused Region Comparison

The focused same-input comparison confirms that both the source and implementation render the command prefix as a discrete colored token followed by ordinary prompt text. The implementation uses the active neutral-theme token palette, which is an intentional theme difference rather than custom styling.

## Comparison History

### Iteration 1 — blocked

- Typeahead covered the full viewport instead of the composer (`05-typeahead-width-fail.png`).
- Collapsed SideNav continued rendering TreeList/search content, causing clipped text and misplaced controls (`13-collapsed-sidebar-overflow-fail.png`).
- Runtime history refresh replaced `/skill` with `$skill` and removed token highlighting (`09-after-refresh-single-dollar-skill.png`).

### Fixes

- Kept native Astryx `ChatComposerInput` and constrained its popover compatibility layer to measured composer bounds in the ClawChat WebView.
- Made `SideNav` collapse controlled and omitted search, `SideNavSection`, and `TreeList` content in rail mode while retaining Astryx layout primitives.
- Preserved Connect-authored slash prompt text when repeated Runtime history serializes the same selected Skill with a dollar prefix.
- Added optimistic Astryx `List`/`ListItem` queue feedback and immediate local edit/delete projection.

### Iteration 2 — passed

- Typeahead is composer-bound (`15-qa3-typeahead-width.png`).
- SideNav rail and re-expansion are visually stable (`16-qa3-sidebar-collapsed.png`, `17-qa3-sidebar-expanded.png`).
- `/skill` token survives completion and hard refresh without duplication (`21-qa3-skill-before-refresh.png`, `22-qa3-skill-after-refresh.png`).
- Queue actions update in under one second in the real Liveware WebView (`18-qa3-queue-feedback.png` through `20-qa3-delete-feedback.png`).

## Primary Interactions Tested

- Open and select a Skill from `/` Typeahead.
- Collapse and expand SideNav.
- Submit while an Agent turn is active, then withdraw/edit and delete queued turns.
- Wait for Agent completion and verify composer exits loading without refresh.
- Hard refresh and verify transcript identity and tokenized Skill preservation.

The full automated suite also passed with 473 tests, typechecking, Biome, and the complete browser integration flow. Connect Service logs were checked during Liveware QA; no new UI-script error was observed. A separate approximately 40-second Liveware 503/reconnection delay was observed after reinstall/refresh, but it did not alter the recovered UI state and is outside this visual-composition pass.

## Implementation Checklist

- [x] Composer-bound Skill Typeahead
- [x] SideNav rail hides TreeList/search
- [x] Centered rail actions and clean expand recovery
- [x] Optimistic queue feedback with immediate edit/delete projection
- [x] `/skill` identity and token styling survive hard refresh
- [x] Loading automatically returns to idle

final result: passed
