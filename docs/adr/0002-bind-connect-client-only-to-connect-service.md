# Bind Connect Client only to Connect Service

Connect Client communicates only with Connect Service and never accesses a local agent runtime, executable, SDK, credential, or Session store directly. Connect Service owns Runtime Adapters, queueing, lifecycle, transcripts, and output routing behind a runtime-neutral Client Interface so adding Codex, OpenCode, Claude, or another runtime does not change the Client seam.
