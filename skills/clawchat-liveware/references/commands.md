# Liveware command reference

All commands select the current binding from `CLAWCHAT_CONNECT_AGENT_ID`. Add `--agent <binding-id>` only for an intentional override.

```text
clawchat-connect liveware app list
clawchat-connect liveware app inspect --app-id <id>
clawchat-connect liveware app create --name <name> [--policy private|public]
clawchat-connect liveware app access --app-id <id> --policy private|public
clawchat-connect liveware app delete --app-id <id>
clawchat-connect liveware tunnel bind --app-id <id> --upstream http://127.0.0.1:<port>
clawchat-connect liveware tunnel unbind --app-id <id>
```

Each command writes one JSON result record. Commands are submitted through Connect's SQLite request queue and executed by the running Service. They never expose the ClawChat or Liveware token.
