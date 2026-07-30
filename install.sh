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
  release_channel_url="https://raw.githubusercontent.com/${repository}/release-channel/latest-alpha.txt"
  version="$(
    curl --proto '=https' --tlsv1.2 --fail --location --silent --show-error --retry 3 "$release_channel_url" |
      awk 'NF { print $1; exit }'
  )"
  [ -n "$version" ] || fail "alpha release channel was empty for ${repository}"
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
transaction_started=0
transaction_committed=0

restore_target() {
  target="$1"
  backup="$2"
  existed="$3"
  rm -rf "$target"
  if [ "$existed" = 1 ]; then cp -R "$backup" "$target"; fi
}

cleanup() {
  status=$?
  trap - 0 1 2 3 15
  if [ "$transaction_started" = 1 ] && [ "$transaction_committed" = 0 ]; then
    restore_target "$install_dir/clawchat-connect" "$tmp_dir/backup/connect" "$connect_existed"
    restore_target "$install_dir/liveware" "$tmp_dir/backup/liveware" "$liveware_existed"
    restore_target "$install_dir/clawchat-connect-client" "$tmp_dir/backup/client" "$client_existed"
    restore_target "$install_dir/skills" "$tmp_dir/backup/skills" "$skills_existed"
    restore_target "$license_dir" "$tmp_dir/backup/licenses" "$licenses_existed"
  fi
  rm -rf "$tmp_dir"
  exit "$status"
}
trap cleanup 0 1 2 3 15

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

"$tmp_dir/clawchat-connect" --help >/dev/null
"$tmp_dir/liveware" --help >/dev/null
"$tmp_dir/clawchat-connect" skills preflight >/dev/null

mkdir -p "$install_dir" "$tmp_dir/backup"
connect_staging="$install_dir/.clawchat-connect.new.$$"
liveware_staging="$install_dir/.liveware.new.$$"
client_staging="$install_dir/.clawchat-connect-client.new.$$"
skills_staging="$install_dir/.skills.new.$$"
licenses_staging="$install_dir/.licenses.new.$$"
cp "$tmp_dir/clawchat-connect" "$connect_staging"
cp "$tmp_dir/liveware" "$liveware_staging"
chmod 755 "$connect_staging" "$liveware_staging"
cp -R "$tmp_dir/clawchat-connect-client" "$client_staging"
cp -R "$tmp_dir/skills" "$skills_staging"
mkdir -p "$licenses_staging"
cp "$tmp_dir/CHANGELOG.md" "$tmp_dir/LICENSE" "$tmp_dir/THIRD_PARTY_NOTICES.md" "$licenses_staging/"

connect_existed=0
liveware_existed=0
client_existed=0
skills_existed=0
licenses_existed=0
if [ -e "$install_dir/clawchat-connect" ]; then
  connect_existed=1
  cp -R "$install_dir/clawchat-connect" "$tmp_dir/backup/connect"
fi
if [ -e "$install_dir/liveware" ]; then
  liveware_existed=1
  cp -R "$install_dir/liveware" "$tmp_dir/backup/liveware"
fi
if [ -e "$install_dir/clawchat-connect-client" ]; then
  client_existed=1
  cp -R "$install_dir/clawchat-connect-client" "$tmp_dir/backup/client"
fi
if [ -e "$install_dir/skills" ]; then
  skills_existed=1
  cp -R "$install_dir/skills" "$tmp_dir/backup/skills"
fi
if [ -e "$license_dir" ]; then
  licenses_existed=1
  cp -R "$license_dir" "$tmp_dir/backup/licenses"
fi

transaction_started=1
mkdir -p "$(dirname "$license_dir")"
rm -rf "$install_dir/clawchat-connect" "$install_dir/liveware" "$install_dir/clawchat-connect-client" "$install_dir/skills" "$license_dir"
mv "$connect_staging" "$install_dir/clawchat-connect"
mv "$liveware_staging" "$install_dir/liveware"
mv "$client_staging" "$install_dir/clawchat-connect-client"
mv "$skills_staging" "$install_dir/skills"
mv "$licenses_staging" "$license_dir"
"$install_dir/clawchat-connect" skills install >/dev/null
transaction_committed=1

printf 'Installed clawchat-connect to %s/clawchat-connect\n' "$install_dir"
printf 'Installed bundled Liveware to %s/liveware\n' "$install_dir"
printf 'Installed Connect Client assets to %s/clawchat-connect-client\n' "$install_dir"
printf 'Installed managed Agent skills to %s/.agents/skills\n' "$HOME"
printf 'Installed license notices to %s\n' "$license_dir"
case ":${PATH}:" in
  *":${install_dir}:"*) ;;
  *) printf 'Add %s to PATH before running clawchat-connect.\n' "$install_dir" ;;
esac
