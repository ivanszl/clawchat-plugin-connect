#!/bin/sh

set -eu

connect_binary="${1:?Connect executable is required}"
official_plugins_directory="${2:?official Plugins directory is required}"
archive="${3:?archive path is required}"
plugin_target="${4:?official Plugin target is required}"
script_directory="$(CDPATH= cd -- "$(dirname "$0")" && pwd)"
repository_root="$(dirname "$script_directory")"
staging_directory="$(mktemp -d "${TMPDIR:-/tmp}/clawchat-connect-windows-release.XXXXXX")"
archive_directory="$(dirname "$archive")"
archive_name="$(basename "$archive")"
trap 'rm -rf "$staging_directory"' 0 1 2 3 15

test -f "$connect_binary"
test -d "$official_plugins_directory"
case "$plugin_target" in
  win32-arm64 | win32-x64) ;;
  *)
    printf 'Unsupported official Plugin target: %s\n' "$plugin_target" >&2
    exit 1
    ;;
esac
for official_plugin_id in clawling.runtime.codex clawling.runtime.deepseek-harness clawling.runtime.opencode clawling.exposure.liveware; do
  official_plugin_found=0
  for official_plugin_bundle in "$official_plugins_directory/${official_plugin_id}-"*.connect-plugin; do
    if [ -f "$official_plugin_bundle" ]; then official_plugin_found=1; break; fi
  done
  [ "$official_plugin_found" = 1 ]
done
test -f "$repository_root/LICENSE"
test -f "$repository_root/CHANGELOG.md"
test -f "$repository_root/skills/manifest.json"
test ! -e "$archive"

mkdir -p "$archive_directory"
archive_directory="$(CDPATH= cd -- "$archive_directory" && pwd)"
archive="$archive_directory/$archive_name"

cp "$connect_binary" "$staging_directory/clawchat-connect.exe"
cp -R "$official_plugins_directory" "$staging_directory/official-plugins"
cp -R "$repository_root/skills" "$staging_directory/skills"
cp "$repository_root/LICENSE" "$repository_root/CHANGELOG.md" "$staging_directory/"

(
  cd "$staging_directory"
  zip -q -r "$archive" \
    clawchat-connect.exe \
    official-plugins \
    skills \
    CHANGELOG.md \
    LICENSE
)
