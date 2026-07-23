#!/bin/sh

set -eu

output="${1:?output path is required}"
script_directory="$(CDPATH= cd -- "$(dirname "$0")" && pwd)"
repository_root="$(dirname "$script_directory")"

case "$(uname -s)" in
  Darwin) operating_system="darwin" ;;
  Linux) operating_system="linux" ;;
  MINGW* | MSYS* | CYGWIN*) operating_system="windows" ;;
  *) printf 'Liveware is not bundled for operating system %s\n' "$(uname -s)" >&2; exit 1 ;;
esac

case "$(uname -m)" in
  arm64 | aarch64) architecture="arm64" ;;
  x86_64 | amd64) architecture="amd64" ;;
  *) printf 'Liveware is not bundled for architecture %s\n' "$(uname -m)" >&2; exit 1 ;;
esac

asset="liveware-${operating_system}-${architecture}"
if [ "$operating_system" = "windows" ]; then
  asset="${asset}.exe"
fi
sh "$script_directory/verify-liveware-bundle.sh" "$asset"
mkdir -p "$(dirname "$output")"
cp "$repository_root/vendor/liveware/$asset" "$output"
chmod 755 "$output"
