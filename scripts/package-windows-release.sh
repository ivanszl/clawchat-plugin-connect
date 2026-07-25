#!/bin/sh

set -eu

connect_binary="${1:?Connect executable is required}"
client_directory="${2:?Client directory is required}"
liveware_binary="${3:?Liveware executable is required}"
archive="${4:?archive path is required}"
script_directory="$(CDPATH= cd -- "$(dirname "$0")" && pwd)"
repository_root="$(dirname "$script_directory")"
staging_directory="$(mktemp -d "${TMPDIR:-/tmp}/clawchat-connect-windows-release.XXXXXX")"
archive_directory="$(dirname "$archive")"
archive_name="$(basename "$archive")"
trap 'rm -rf "$staging_directory"' 0 1 2 3 15

test -f "$connect_binary"
test -f "$client_directory/index.html"
test -f "$liveware_binary"
test -f "$repository_root/LICENSE"
test -f "$repository_root/THIRD_PARTY_NOTICES.md"
test -f "$repository_root/CHANGELOG.md"
test ! -e "$archive"

mkdir -p "$archive_directory"
archive_directory="$(CDPATH= cd -- "$archive_directory" && pwd)"
archive="$archive_directory/$archive_name"

cp "$connect_binary" "$staging_directory/clawchat-connect.exe"
cp "$liveware_binary" "$staging_directory/liveware.exe"
cp -R "$client_directory" "$staging_directory/clawchat-connect-client"
cp "$repository_root/LICENSE" "$repository_root/THIRD_PARTY_NOTICES.md" "$repository_root/CHANGELOG.md" "$staging_directory/"

(
  cd "$staging_directory"
  zip -q -r "$archive" \
    clawchat-connect.exe \
    clawchat-connect-client \
    liveware.exe \
    CHANGELOG.md \
    LICENSE \
    THIRD_PARTY_NOTICES.md
)
