---
status: superseded
superseded-by: 0016
---

# Open Connect Client directly on loopback

`clawchat-connect web` opens the fixed loopback URL without a local login, launch token, Cookie, or CSRF state. Connect Service binds only to `127.0.0.1`, validates the exact Host header, and accepts mutations only from its exact Origin with compatible Fetch Metadata. This intentionally favors a simple single-user local interface; remote exposure remains out of scope.
