#!/bin/sh

set -eu

connect_binary="${1:?connect binary is required}"
client_directory="${2:?client directory is required}"
liveware_binary="${3:?liveware binary is required}"
archive="${4:?archive path is required}"
script_directory="$(CDPATH= cd -- "$(dirname "$0")" && pwd)"
repository_root="$(dirname "$script_directory")"
staging_directory="$(mktemp -d "${TMPDIR:-/tmp}/clawchat-connect-release.XXXXXX")"
trap 'rm -rf "$staging_directory"' 0 1 2 3 15

test -x "$connect_binary"
test -f "$client_directory/index.html"
test -x "$liveware_binary"
test -f "$repository_root/LICENSE"
test -f "$repository_root/CHANGELOG.md"
test -f "$repository_root/skills/manifest.json"

cp "$connect_binary" "$staging_directory/clawchat-connect"
cp "$liveware_binary" "$staging_directory/liveware"
cp -R "$client_directory" "$staging_directory/clawchat-connect-client"
cp -R "$repository_root/skills" "$staging_directory/skills"
cp "$repository_root/LICENSE" "$repository_root/CHANGELOG.md" "$staging_directory/"
chmod 755 "$staging_directory/clawchat-connect" "$staging_directory/liveware"

tar -C "$staging_directory" -czf "$archive" \
  clawchat-connect \
  clawchat-connect-client \
  liveware \
  skills \
  CHANGELOG.md \
  LICENSE
