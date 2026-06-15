# acpx Agent Support Reference

This document records how `openclaw/acpx` maps common coding agents to ACP startup commands. It is reference material for improving ClawChat Connect agent presets and documentation; Connect should borrow the registry and compatibility lessons, not depend on `acpx` as a runtime layer.

## Built-in Agent Mapping

| Agent | acpx command | ACP startup command | Support type | Notes for ClawChat Connect |
|---|---|---|---|---|
| Pi | `acpx pi` | `npx pi-acp` | External ACP adapter | Possible preset if Pi runtime support is desired later. |
| OpenClaw | `acpx openclaw` | `openclaw acp` | Native ACP bridge | Useful for parity testing, but Connect is not an OpenClaw plugin. |
| Codex | `acpx codex` | `npx -y @agentclientprotocol/codex-acp` | External ACP adapter | Prefer this over assuming `codex` itself is the ACP server. |
| Claude | `acpx claude` | `npx -y @agentclientprotocol/claude-agent-acp` | External ACP adapter | Correct Claude path; do not document `claude` CLI itself as the ACP server. |
| Gemini | `acpx gemini` | `gemini --acp` | Native ACP | Older versions may require `--experimental-acp`. |
| Cursor | `acpx cursor` | `cursor-agent acp` | Native ACP | Some installs may expose a different binary; keep override support. |
| Copilot | `acpx copilot` | `copilot --acp --stdio` | Native ACP | acpx preflights `copilot --help` for `--acp` support. |
| Droid | `acpx droid` | `droid exec --output-format acp` | Native/CLI ACP output | `factory-droid` and `factorydroid` are aliases in acpx. |
| fast-agent | `acpx fast-agent` | `uvx fast-agent-mcp acp` | External bridge | Python/uvx-based bridge. |
| iFlow | `acpx iflow` | `iflow --experimental-acp` | Experimental native ACP | Treat as experimental. |
| Kilocode | `acpx kilocode` | `npx -y @kilocode/cli acp` | CLI ACP mode | Candidate preset if Connect supports broader agent templates. |
| Kimi | `acpx kimi` | `kimi acp` | Native ACP | Candidate preset. |
| Kiro | `acpx kiro` | `kiro-cli-chat acp` | Native ACP | Candidate preset. |
| Mux | `acpx mux` | `npx -y mux@^0.27.0 acp` | CLI ACP mode | acpx pins a package range. |
| OpenCode | `acpx opencode` | `npx -y opencode-ai acp` | CLI ACP mode | Prefer this preset over a bare `opencode` command. |
| Qoder | `acpx qoder` | `qodercli --acp` | Native ACP | acpx adds compatibility for allowed tools, max turns, and stdin close timing. |
| Qwen | `acpx qwen` | `qwen --acp` | Native ACP | Candidate preset. |
| Trae | `acpx trae` | `traecli acp serve` | Native ACP | Candidate preset. |

## Patterns Worth Borrowing

| Priority | Pattern | acpx behavior | Connect implication |
|---|---|---|---|
| P0 | Agent registry | Maps short names such as `claude`, `codex`, and `opencode` to concrete ACP commands. | Add built-in presets/templates so users do not have to know adapter package names. |
| P0 | Command plus args model | Splits command lines into executable + args before spawning. | Store `command` and `args` in config, or support a safe raw command parser. |
| P0 | Correct Claude mapping | Uses `@agentclientprotocol/claude-agent-acp`. | Fix docs/examples to avoid implying Claude Code CLI is directly ACP-native. |
| P0 | Correct Codex mapping | Uses `@agentclientprotocol/codex-acp`. | Prefer adapter-based Codex examples unless a verified native ACP path is configured. |
| P1 | Overrides | Allows config to override built-in agent commands. | Preserve local customization for alternate install paths and versions. |
| P1 | Startup preflight | Checks some agent CLIs for ACP support or version quirks. | Add clear validation errors for missing commands or unsupported ACP flags. |
| P1 | Agent compatibility shims | Handles Claude metadata, Gemini flag fallback, Copilot support checks, and Qoder options. | Add only targeted shims where real agent behavior requires them. |
| P2 | Session resilience | Supports resume/load fallback, crash reconnect, queueing, cancel, and TTL. | Use as reference for hardening Connect's existing chat/session manager. |
| Avoid | Calling `acpx` as runtime | acpx is itself an ACP client. | Do not chain Connect -> acpx -> ACP by default; Connect should remain the ClawChat ACP client. |
