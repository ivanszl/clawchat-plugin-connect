#!/bin/sh

set -eu

script_directory="$(CDPATH= cd -- "$(dirname "$0")" && pwd)"
repository_root="$(dirname "$script_directory")"
bundle_directory="$repository_root/vendor/liveware"
manifest="$bundle_directory/SHA256SUMS"

checksum() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{ print $1 }'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{ print $1 }'
  else
    printf 'sha256sum or shasum is required\n' >&2
    exit 1
  fi
}

verify_asset() {
  asset="$1"
  expected_checksum="$(awk -v asset="$asset" '$2 == asset { print $1; exit }' "$manifest")"
  test -n "$expected_checksum"
  test -f "$bundle_directory/$asset"
  actual_checksum="$(checksum "$bundle_directory/$asset")"
  if [ "$actual_checksum" != "$expected_checksum" ]; then
    printf 'Liveware %s checksum mismatch: expected %s, got %s\n' \
      "$asset" "$expected_checksum" "$actual_checksum" >&2
    exit 1
  fi
}

if [ "$#" -gt 0 ]; then
  verify_asset "$1"
else
  while read -r _ asset
  do
    verify_asset "$asset"
  done < "$manifest"
fi
