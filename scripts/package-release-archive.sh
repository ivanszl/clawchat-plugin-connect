#!/bin/sh

set -eu

connect_binary="${1:?connect binary is required}"
official_plugins_directory="${2:?official Plugins directory is required}"
archive="${3:?archive path is required}"
plugin_target="${4:?official Plugin target is required}"
script_directory="$(CDPATH= cd -- "$(dirname "$0")" && pwd)"
repository_root="$(dirname "$script_directory")"
staging_directory="$(mktemp -d "${TMPDIR:-/tmp}/clawchat-connect-release.XXXXXX")"
trap 'rm -rf "$staging_directory"' 0 1 2 3 15

test -x "$connect_binary"
test -d "$official_plugins_directory"
case "$plugin_target" in
  darwin-arm64 | darwin-x64)
    required_official_plugin_ids="clawling.runtime.codex clawling.runtime.deepseek-harness clawling.runtime.opencode clawling.runtime.workbuddy clawling.exposure.liveware"
    ;;
  linux-arm64 | linux-x64)
    required_official_plugin_ids="clawling.runtime.codex clawling.runtime.deepseek-harness clawling.runtime.opencode clawling.exposure.liveware"
    ;;
  *)
    printf 'Unsupported official Plugin target: %s\n' "$plugin_target" >&2
    exit 1
    ;;
esac
for official_plugin_id in $required_official_plugin_ids; do
  official_plugin_found=0
  for official_plugin_bundle in "$official_plugins_directory/${official_plugin_id}-"*.connect-plugin; do
    if [ -f "$official_plugin_bundle" ]; then official_plugin_found=1; break; fi
  done
  [ "$official_plugin_found" = 1 ]
done
test -f "$repository_root/LICENSE"
test -f "$repository_root/CHANGELOG.md"
test -f "$repository_root/skills/manifest.json"

cp "$connect_binary" "$staging_directory/clawchat-connect"
cp -R "$official_plugins_directory" "$staging_directory/official-plugins"
cp -R "$repository_root/skills" "$staging_directory/skills"
cp "$repository_root/LICENSE" "$repository_root/CHANGELOG.md" "$staging_directory/"
chmod 755 "$staging_directory/clawchat-connect"

tar -C "$staging_directory" -czf "$archive" \
  clawchat-connect \
  official-plugins \
  skills \
  CHANGELOG.md \
  LICENSE
