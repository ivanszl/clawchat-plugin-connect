# Security Policy

ClawChat Connect is alpha software and currently supports the release line documented in `README.md`.

Please report suspected credential disclosure, arbitrary file disclosure, request forgery, authentication bypass, or remote code execution privately to the repository maintainers through GitHub's private vulnerability reporting. If that channel is unavailable, open a minimal public issue requesting private contact without including vulnerability details. Do not include live credentials, private conversation content, or proprietary source files in a public issue.

Until a fix is available, stop the user service with `clawchat-connect service stop`, rotate the affected ClawChat activation credentials, set `livewareAccessPolicy` to `off`, and remove untrusted LAN exposure from the configuration.

A Liveware Exposure presents the complete Connect Client. `private` admits only the Connect Owner and is the default; `public` admits any authenticated ClawChat user who can open the App. Connect intentionally adds no separate remote roles or capability filtering. Its Project directory picker can enumerate directory names and structure across the Connect Service host, although it does not display file contents. Use `public` only when every admitted user may inspect that host directory structure and Sessions, manage Project paths and preferences, and submit local runtime turns.

Windows installs use a current-user Task Scheduler task and a generated `%USERPROFILE%\.clawchat-connect\service.ps1`; neither requires elevation. Release executables are alpha artifacts and may trigger Windows SmartScreen until code signing is configured. Verify the published SHA-256 checksums before bypassing an execution warning.
