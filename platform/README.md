# Clawnest DSH integration release

Native images provide DSH/SDK and the fixed signed-package bootstrap. This
platform directory supplies the separately published integration: Core binary,
matching official Runtime Plugin, adapter, bridge and managed skills. Supervisor
startup/program configuration remains outside this package in platform mounts.

Build Core with the pinned Linux baseline Bun target using `platform/entry.ts`,
and build the official DSH plugin with `scripts/build-official-plugins.ts`. Keep
its verified integrity synchronized with the embedded official registry. Stage
with `python3 platform/package-dsh.py --updater-source /path/to/clawnest-plugins/skills/clawnest-plugin-update --output NEW_DIRECTORY`,
then use `clawnest-plugins/tools/pack-node-integration.py` with the native image's
observed host config and an independent integration semver. Publish through the
existing signed static catalogue; image rebuilding is not part of this release.

The adapter resolves Core/plugin files relative to its immutable release. It
updates only release-managed bridge paths and keeps user-selected DSH profiles.
Owner greeting metadata comes from `/v1/agents/me/owner`, not a public profile.
Wait for that request before generation; preserve a known locale and default to
English only when the owner has not reported one. A completed, unsent draft is
regenerated if its locale changes; uncertain delivery keeps its stable request
and receipt instead of sending another greeting.

Running updates quiesce browser work and the Core binding before Supervisor
restarts only `dsh-agent`. The owner-only control socket never passes Manager
credentials into model tools. Image and integration updates retain all existing
HOME data and canonical identity.
