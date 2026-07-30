---
status: accepted
---

# Install Connect Agent Skills at user scope

Connect releases carry two focused instruction packages, `clawchat-core` for ClawChat operations and `clawchat-liveware` for Agent-managed app deployment. Installers place them by default under the current user's `$HOME/.agents/skills`, the documented Codex user-skill scope, so they are discoverable across repositories without adding repo-local instructions.

The skills teach Agents to invoke Connect's CLI and do not register runtime-native tools or an MCP server. Keeping core social operations and Liveware deployment separate preserves focused implicit-trigger descriptions and lets either workflow evolve without crowding the other.

Both skills permit implicit invocation. The core description targets explicit ClawChat social, profile, message, moment, and attachment intents. The Liveware description targets explicit Liveware or ClawChat App publication intents; it does not claim unrelated generic Web deployment requests, while every selected Liveware workflow completes ClawChat registration.

Both target directories are Connect-managed release artifacts. Every Connect installation and update atomically replaces them with the bundled copies, even when their installed contents were edited locally; users who need a customized workflow must create a differently named skill rather than modify the managed copy.

The skills are mandatory parts of the release contract. Installers validate and stage every artifact and preflight both the Connect installation target and the user skill target before replacing existing files. A missing, invalid, or unwritable skill fails the installation or update instead of reporting success with a CLI and skill version mismatch; late replacement failures restore the previous managed skill copies.

POSIX and Windows standalone installers, the built-in updater, and the npm global package all carry, install, and validate the same skill sources. The npm lifecycle performs the normal atomic sync; when lifecycle execution is disabled, the resulting installation remains incomplete and runtime preflight directs the user to an explicit bundled local repair command rather than silently operating without the skills.

The managed manifest records the owning Connect release and checksums for both installed skills. Doctor, Connect Service startup, and Agent Binding startup require an exact match with the running binary. The offline `clawchat-connect skills install` repair command uses only files bundled with the installed release and atomically force-replaces both targets.
