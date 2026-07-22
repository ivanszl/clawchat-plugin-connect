# Keep web separate from Service lifecycle

`clawchat-connect web` requires an already running Connect Service and fails with an actionable Service-management instruction when it cannot connect; it never starts, installs, or restarts the Service. The foreground `run` command is planned to leave the public workflow, so native per-user Service commands own lifecycle while `web` only authorizes and opens Connect Client.
