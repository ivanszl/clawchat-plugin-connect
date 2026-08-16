---
status: superseded by ADR-0047
---

# Create an inline Project when its Session is confirmed

Creating a Project from the new-Session flow remains pending in the Client until the user confirms “Create Session.” The resulting Client command creates a requested host directory when needed, reuses an existing Project at the same canonical root or registers a new one, and then creates the Session against that Project. If Session creation fails, Connect removes only the Project created by that command when it remains unreferenced and removes only a directory created by that command when it remains empty; pre-existing Projects and directories are never rolled back. This avoids leaving installation-global Projects or empty host directories when a user cancels the dialog or Session creation fails.
