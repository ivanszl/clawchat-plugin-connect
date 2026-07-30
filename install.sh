#!/bin/sh

set -eu

repository="${CLAWCHAT_CONNECT_REPOSITORY:-clawling/clawchat-plugin-connect}"
version="${1:-${CLAWCHAT_CONNECT_VERSION:-}}"
install_dir="${CLAWCHAT_CONNECT_INSTALL_DIR:-${HOME}/.local/bin}"
license_dir="${CLAWCHAT_CONNECT_LICENSE_DIR:-${install_dir}/clawchat-connect-licenses}"

fail() {
  printf 'clawchat-connect installer: %s\n' "$1" >&2
  exit 1
}

command -v curl >/dev/null 2>&1 || fail "curl is required"
command -v tar >/dev/null 2>&1 || fail "tar is required"

if [ -z "$version" ]; then
  releases_url="https://api.github.com/repos/${repository}/releases?per_page=100"
  version="$(
    curl --proto '=https' --tlsv1.2 --fail --location --silent --show-error --retry 3 "$releases_url" |
      tr ',' '\n' |
      sed -n 's/.*"tag_name":[[:space:]]*"\([^"]*\)".*/\1/p' |
      awk 'NR == 1 { print; exit }'
  )"
  [ -n "$version" ] || fail "latest published release was not found for ${repository}"
fi

case "$version" in
  v*) ;;
  *) version="v$version" ;;
esac

printf '%s\n' "$version" | grep -Eq '^v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$' ||
  fail "invalid release version: ${version}"

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

tar -xzf "$tmp_dir/$asset" -C "$tmp_dir" \
  clawchat-connect clawchat-connect-client liveware skills CHANGELOG.md LICENSE THIRD_PARTY_NOTICES.md
[ -f "$tmp_dir/clawchat-connect" ] || fail "release archive does not contain clawchat-connect"
[ -f "$tmp_dir/clawchat-connect-client/index.html" ] || fail "release archive does not contain Connect Client"
[ -f "$tmp_dir/liveware" ] || fail "release archive does not contain Liveware"
[ -f "$tmp_dir/skills/manifest.json" ] || fail "release archive does not contain Agent skills"
[ -f "$tmp_dir/CHANGELOG.md" ] || fail "release archive does not contain the Changelog"
[ -f "$tmp_dir/LICENSE" ] || fail "release archive does not contain LICENSE"
[ -f "$tmp_dir/THIRD_PARTY_NOTICES.md" ] || fail "release archive does not contain third-party notices"

mkdir -p "$install_dir"
if command -v install >/dev/null 2>&1; then
  install -m 755 "$tmp_dir/clawchat-connect" "$install_dir/clawchat-connect"
  install -m 755 "$tmp_dir/liveware" "$install_dir/liveware"
else
  cp "$tmp_dir/clawchat-connect" "$install_dir/clawchat-connect"
  cp "$tmp_dir/liveware" "$install_dir/liveware"
  chmod 755 "$install_dir/clawchat-connect"
  chmod 755 "$install_dir/liveware"
fi
mkdir -p "$install_dir/clawchat-connect-client"
cp -R "$tmp_dir/clawchat-connect-client/." "$install_dir/clawchat-connect-client/"
skills_staging="$install_dir/skills.new.$$"
rm -rf "$skills_staging"
cp -R "$tmp_dir/skills" "$skills_staging"
rm -rf "$install_dir/skills"
mv "$skills_staging" "$install_dir/skills"
mkdir -p "$license_dir"
cp "$tmp_dir/CHANGELOG.md" "$tmp_dir/LICENSE" "$tmp_dir/THIRD_PARTY_NOTICES.md" "$license_dir/"

"$install_dir/clawchat-connect" --help >/dev/null
"$install_dir/liveware" --help >/dev/null
"$install_dir/clawchat-connect" skills install >/dev/null

printf 'Installed clawchat-connect to %s/clawchat-connect\n' "$install_dir"
printf 'Installed bundled Liveware to %s/liveware\n' "$install_dir"
printf 'Installed Connect Client assets to %s/clawchat-connect-client\n' "$install_dir"
printf 'Installed managed Agent skills to %s/.agents/skills\n' "$HOME"
printf 'Installed license notices to %s\n' "$license_dir"
case ":${PATH}:" in
  *":${install_dir}:"*) ;;
  *) printf 'Add %s to PATH before running clawchat-connect.\n' "$install_dir" ;;
esac
