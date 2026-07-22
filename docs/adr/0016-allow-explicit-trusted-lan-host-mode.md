---
status: accepted
supersedes: 0004, 0005
---

# Allow explicit trusted-LAN Host mode

Connect Client binds to `127.0.0.1` by default and continues to open locally without a login, launch token, Cookie, or browser Session. A user may explicitly configure `clientHost` as `0.0.0.0` to expose the Client Interface on all IPv4 interfaces for trusted-LAN use. No other Host configuration is accepted.

Wildcard binding and browser origin are separate concepts. In LAN mode the server accepts only IPv4-literal Host headers on the configured port and derives the allowed mutation Origin from each request's exact Host. Fetch Metadata, request-size limits, asset-path checks, and CSP remain enforced. Hostnames are rejected to reduce DNS-rebinding exposure.

LAN Host mode does not add authentication or TLS. Anyone able to reach the port can inspect Sessions, register or remove Project paths, change Session and model preferences, select advertised runtime modes including `danger-full-access`, and submit local turns. The CLI and service must warn when LAN mode is enabled. This is an explicit trusted-LAN administration boundary, not an authorization boundary. Internet exposure, port forwarding, reverse-proxy trust, TLS termination, remote identity, and device authorization remain out of scope and require a separate authenticated design.
