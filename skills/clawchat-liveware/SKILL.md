---
name: clawchat-liveware
description: Deploy a local web service as a new Liveware app and register it directly in ClawChat through the bound ClawChat Connect agent. Use only for explicit Liveware or ClawChat App creation, inspection, access-policy, tunneling, deletion, and deployment requests; do not trigger for generic web development or generic deployment.
---

# ClawChat Liveware

Use the `clawchat-connect liveware` structured commands. Connect obtains short-lived credentials internally; never run `liveware login`, read tokens, call Liveware APIs directly, or compose arbitrary Liveware shell commands.

## Workflow

1. Ensure the local service is listening on `http://127.0.0.1:<port>`.
2. Inspect existing apps:

   ```sh
   clawchat-connect liveware app list
   ```

3. Create a uniquely named app. Never use the reserved name `ClawChat Connect`:

   ```sh
   clawchat-connect liveware app create --name '<name>' --policy private
   ```

4. Bind only a loopback HTTP upstream:

   ```sh
   clawchat-connect liveware tunnel bind --app-id '<exact-id>' --upstream 'http://127.0.0.1:<port>'
   ```

   Connect automatically registers a successful bind in ClawChat. A bind fails if registration fails; do not separately call `clawchat_register_app`.

5. Report both the Liveware app ID and registered ClawChat URL.

Use `app inspect`, `app access`, `tunnel unbind`, and `app delete` only with exact IDs and explicit user intent. Do not mutate the reserved managed app. Treat any nonzero exit as final and do not retry.

Read [references/commands.md](references/commands.md) for the complete structured command forms.
