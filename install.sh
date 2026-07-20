#!/bin/sh

set -eu

repository="${CLAWCHAT_CONNECT_REPOSITORY:-XMethues/clawchat-plugin-connect}"
default_version="v0.1.0-alpha.0"
version="${1:-${CLAWCHAT_CONNECT_VERSION:-$default_version}}"
install_dir="${CLAWCHAT_CONNECT_INSTALL_DIR:-${HOME}/.local/bin}"

fail() {
  printf 'clawchat-connect installer: %s\n' "$1" >&2
  exit 1
}

command -v curl >/dev/null 2>&1 || fail "curl is required"
command -v tar >/dev/null 2>&1 || fail "tar is required"

case "$version" in
  v*) ;;
  *) version="v$version" ;;
esac

printf '%s\n' "$version" | grep -Eq '^v[0-9]+\.[0-9]+\.[0-9]+-alpha\.[0-9]+$' ||
  fail "only alpha versions are available (for example: v0.1.0-alpha.0)"

case "$(uname -s)" in
  Darwin) os="darwin" ;;
  Linux) os="linux" ;;
  *) fail "unsupported operating system: $(uname -s)" ;;
esac

case "$(uname -m)" in
  arm64 | aarch64) arch="arm64" ;;
  x86_64 | amd64) arch="x64" ;;
  *) fail "unsupported architecture: $(uname -m)" ;;
esac

asset="clawchat-connect-${os}-${arch}.tar.gz"
base_url="https://github.com/${repository}/releases/download/${version}"
tmp_dir="$(mktemp -d "${TMPDIR:-/tmp}/clawchat-connect.XXXXXX")"
trap 'rm -rf "$tmp_dir"' 0 1 2 3 15

printf 'Downloading ClawChat Connect %s for %s-%s...\n' "$version" "$os" "$arch"
curl --proto '=https' --tlsv1.2 --fail --location --silent --show-error --retry 3 \
  "$base_url/$asset" --output "$tmp_dir/$asset"
curl --proto '=https' --tlsv1.2 --fail --location --silent --show-error --retry 3 \
  "$base_url/checksums.txt" --output "$tmp_dir/checksums.txt"

expected_checksum="$(awk -v asset="$asset" '$2 == asset || $2 == "*" asset { print $1; exit }' "$tmp_dir/checksums.txt")"
[ -n "$expected_checksum" ] || fail "release checksum for $asset was not found"

if command -v sha256sum >/dev/null 2>&1; then
  actual_checksum="$(sha256sum "$tmp_dir/$asset" | awk '{ print $1 }')"
elif command -v shasum >/dev/null 2>&1; then
  actual_checksum="$(shasum -a 256 "$tmp_dir/$asset" | awk '{ print $1 }')"
else
  fail "sha256sum or shasum is required"
fi

[ "$actual_checksum" = "$expected_checksum" ] || fail "checksum verification failed for $asset"

tar -xzf "$tmp_dir/$asset" -C "$tmp_dir" clawchat-connect
[ -f "$tmp_dir/clawchat-connect" ] || fail "release archive does not contain clawchat-connect"

mkdir -p "$install_dir"
if command -v install >/dev/null 2>&1; then
  install -m 755 "$tmp_dir/clawchat-connect" "$install_dir/clawchat-connect"
else
  cp "$tmp_dir/clawchat-connect" "$install_dir/clawchat-connect"
  chmod 755 "$install_dir/clawchat-connect"
fi

"$install_dir/clawchat-connect" --help >/dev/null

printf 'Installed clawchat-connect to %s/clawchat-connect\n' "$install_dir"
case ":${PATH}:" in
  *":${install_dir}:"*) ;;
  *) printf 'Add %s to PATH before running clawchat-connect.\n' "$install_dir" ;;
esac
