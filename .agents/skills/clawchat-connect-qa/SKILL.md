---
name: clawchat-connect-qa
description: Run evidence-based acceptance tests against the real locally installed ClawChat Connect, ClawChat desktop app, Connect Client, Agent Bindings, group intake, commands, Runtime interactions, attachments, ClawChat tools, and Liveware. Use when validating a local Connect build end to end, reproducing a ClawChat/Connect integration bug, qualifying a release, or verifying a fix in the signed-in desktop surfaces.
---

# ClawChat Connect QA

Test what the user can actually see and do. Treat repository tests and service logs as supporting evidence, never as a substitute for the real ClawChat or Connect Client surface.

## Prepare the run

1. Read `references/capability-matrix.md` and mark every applicable row pending.
2. Record the installed Connect version, `doctor`, service status, configured Agent Bindings, and the test conversations authorized by the user.
3. Generate a unique run label such as `connect-qa-YYYYMMDD-HHMM` and use it in Session names and reversible test content.
4. Start a fresh Session with `/new <run-label>` before testing Runtime behavior. Never reuse prior transcript state as proof.
5. Inspect the current ClawChat UI before acting. Use Computer Use for the desktop app and embedded Liveware; use Browser only for the standalone loopback Connect Client.

## Execute with evidence

For each matrix row:

1. State the expected visible outcome and target surface.
2. Capture fresh accessibility state before the action.
3. Perform the smallest authorized action. Re-fetch fresh state after every click, input, or send.
4. Record the exact visible response, reply target, Session name, and relevant service/log evidence.
5. Classify the result as `pass`, `product-failure`, `environment-blocked`, or `not-authorized`.
6. On product failure, preserve the first divergence, add the narrowest automated regression, fix, rebuild, reinstall, restart, and repeat the real action in a new Session when state could affect the result.

Do not silently replace a failed real-surface test with a CLI call. CLI and SQLite reads may establish exact IDs or durable state, but the requested user flow must still be exercised through ClawChat.

Distinguish transport success from presentation success. A persisted outbound record and `message.ack` prove that Connect and the ClawChat message hub accepted a reply; they do not prove that the desktop history rendered it. If a conversation preview shows an acknowledged reply but the open history omits it, record an upstream ClawChat presentation failure instead of reporting that Connect dropped the Runtime final.

If Browser reports that no browser is available, mark only the standalone loopback Client row `environment-blocked`. Continue the embedded Client row through the ClawChat Liveware WebView with Computer Use.

## Safety and cleanup

- Limit messages and mutations to conversations and accounts explicitly authorized for the run.
- Use exact IDs obtained from authoritative turn context, visible UI, or a successful tool result; never infer IDs from display names.
- Do not leave the test group, remove friends, change profile fields, publish Moments, or register/unregister apps unless those mutations and cleanup targets were explicitly authorized.
- For reversible mutation tests, create uniquely labeled ephemeral data, verify it, then restore or delete only that exact data.
- Keep required control interactions visible. Never auto-approve an unexpected permission or secret prompt.
- Treat an expected Runtime request to authorize or mount the exact test workspace directory as a normal human-in-the-loop prerequisite, not a product failure. Record the pause, ask the user to approve that exact directory, and resume the same case; never broaden it to an unrelated path.
- Preserve unrelated repository and user data. Do not reset a dirty worktree.

## Maintain this skill

After each real run, update `references/capability-matrix.md` only with reusable procedures, prerequisites, and proven failure signatures. Keep run-specific IDs, screenshots, messages, and results outside the skill. Validate the skill with the skill-creator `quick_validate.py` script after edits.
