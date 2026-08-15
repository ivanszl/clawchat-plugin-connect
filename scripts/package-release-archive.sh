#!/bin/sh

set -eu

connect_binary="${1:?connect binary is required}"
client_directory="${2:?client directory is required}"
liveware_binary="${3:?liveware binary is required}"
official_plugins_directory="${4:?official Plugins directory is required}"
archive="${5:?archive path is required}"
script_directory="$(CDPATH= cd -- "$(dirname "$0")" && pwd)"
repository_root="$(dirname "$script_directory")"
staging_directory="$(mktemp -d "${TMPDIR:-/tmp}/clawchat-connect-release.XXXXXX")"
trap 'rm -rf "$staging_directory"' 0 1 2 3 15

test -x "$connect_binary"
test -f "$client_directory/index.html"
test -x "$liveware_binary"
test -d "$official_plugins_directory"
for official_plugin_id in clawling.runtime.codex clawling.runtime.opencode clawling.runtime.workbuddy; do
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
cp "$liveware_binary" "$staging_directory/liveware"
cp -R "$client_directory" "$staging_directory/clawchat-connect-client"
cp -R "$official_plugins_directory" "$staging_directory/official-plugins"
cp -R "$repository_root/skills" "$staging_directory/skills"
cp "$repository_root/LICENSE" "$repository_root/CHANGELOG.md" "$staging_directory/"
chmod 755 "$staging_directory/clawchat-connect" "$staging_directory/liveware"

tar -C "$staging_directory" -czf "$archive" \
  clawchat-connect \
  clawchat-connect-client \
  official-plugins \
  liveware \
  skills \
  CHANGELOG.md \
  LICENSE
