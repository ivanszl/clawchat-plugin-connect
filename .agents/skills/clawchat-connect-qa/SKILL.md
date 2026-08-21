---
name: clawchat-connect-qa
description: Run evidence-based acceptance tests against the real ClawChat Android debug app on clawlingdev:5558, the locally installed ClawChat Connect service, Connect Client, Agent Bindings, group intake, commands, Runtime interactions, attachments, ClawChat tools, and Liveware. Use when validating a local Connect build end to end, reproducing a ClawChat/Connect integration bug, qualifying a release, or verifying a fix in signed-in ClawChat surfaces.
---

# ClawChat Connect QA

Test what the user can actually see and do. Treat repository tests and service logs as supporting evidence, never as a substitute for the real ClawChat or Connect Client surface.

## Surface policy

- Test ClawChat behavior through the Android debug app by SSHing to `clawlingdev` and targeting ADB device `emulator-5558`.
- Android is the default and exclusive ClawChat behavior surface. Do not fall back to local Desktop CUA when Android is unavailable; classify the affected row as `environment-blocked`.
- Use the installed debug app as-is. Do not inspect its version, reinstall it, clear its data, or otherwise manage the app unless the task explicitly concerns installation or upgrade behavior.
- Dedicated QA Agent conversations and conversations explicitly named as QA targets are standing-authorized for uniquely labeled test messages and Connect control commands. Do not broaden that authorization to ordinary contacts, groups, account settings, Moments, or app registration.
- Choose Session isolation and cleanup from the behavior under test. Use a fresh Session when prior Runtime state could affect the result; do not create one mechanically for tests where Session state is irrelevant.
- Desktop remains available only when the target is genuinely surface-specific, such as Liveware wide/narrow responsive layout or desktop WebView presentation. Do not duplicate ordinary ClawChat behavior checks on Desktop.
- Prefer structured Android UI state such as UIAutomator XML for interaction and assertions. Use screenshots when layout or rendering is itself the behavior under test.

## Prepare the run

1. Read `references/capability-matrix.md` and mark every applicable row pending.
2. Record the installed Connect version, `doctor`, service status, configured Agent Bindings, and the test conversations authorized by the user.
3. Generate a unique run label such as `connect-qa-YYYYMMDD-HHMM` and use it in Session names and reversible test content.
4. Choose the Session and cleanup strategy required by the behavior under test; when a fresh Session is required, use `/new <run-label>`.
5. Inspect the current Android ClawChat UI on `clawlingdev` / `emulator-5558` before acting. Use Desktop only for the surface-specific exceptions above and Browser only for the standalone loopback Connect Client.

## Execute with evidence

For each matrix row:

1. State the expected visible outcome and target surface.
2. Capture fresh accessibility state before the action.
3. Perform the smallest authorized action. Re-fetch fresh state after every click, input, or send.
4. Record the exact visible response, reply target, Session name, and relevant service/log evidence.
5. Classify the result as `pass`, `product-failure`, `environment-blocked`, or `not-authorized`.
6. On product failure, preserve the first divergence, add the narrowest automated regression, fix, rebuild, reinstall, restart, and repeat the real action in a new Session when state could affect the result.

Do not silently replace a failed real-surface test with a CLI call. CLI and SQLite reads may establish exact IDs or durable state, but the requested user flow must still be exercised through ClawChat.

Distinguish transport success from presentation success. A persisted outbound record and `message.ack` prove that Connect and the ClawChat message hub accepted a reply; they do not prove that the open ClawChat history rendered it. If a conversation preview shows an acknowledged reply but the open history omits it, record an upstream ClawChat presentation failure instead of reporting that Connect dropped the Runtime final.

If Browser reports that no browser is available, mark only the standalone loopback Client row `environment-blocked`. Test embedded Liveware through its intended ClawChat surface: Android for ordinary behavior, or Desktop when the case specifically requires wide/narrow WebView presentation.

## Safety and cleanup

- Limit messages and mutations to the standing-authorized dedicated QA conversations or other conversations and accounts explicitly authorized for the run.
- Use exact IDs obtained from authoritative turn context, visible UI, or a successful tool result; never infer IDs from display names.
- Do not leave the test group, remove friends, change profile fields, publish Moments, or register/unregister apps unless those mutations and cleanup targets were explicitly authorized.
- For reversible mutation tests, create uniquely labeled ephemeral data, verify it, then restore or delete only that exact data.
- Keep required control interactions visible. Never auto-approve an unexpected permission or secret prompt.
- Treat an expected Runtime request to authorize or mount the exact test workspace directory as a normal human-in-the-loop prerequisite, not a product failure. Record the pause, ask the user to approve that exact directory, and resume the same case; never broaden it to an unrelated path.
- Preserve unrelated repository and user data. Do not reset a dirty worktree.

## Maintain this skill

After each real run, update `references/capability-matrix.md` only with reusable procedures, prerequisites, and proven failure signatures. Keep run-specific IDs, screenshots, messages, and results outside the skill. Validate the skill with the skill-creator `quick_validate.py` script after edits.
