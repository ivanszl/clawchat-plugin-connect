---
status: superseded
superseded-by: 0016
---

# Keep Connect Client loopback-only

Connect Client and its Client Interface will listen only on the loopback interface for the first release. Remote administration over LAN or the internet is outside this seam because ClawChat already provides the remote interaction surface, while exposing Connect would require TLS, remote identity, device authorization, and a broader local-machine threat model.
