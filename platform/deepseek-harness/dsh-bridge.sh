#!/bin/sh
set -eu
if [ -n "${CONNECT_DSH_BRIDGE_FD_OUT:-}" ] && [ -n "${CONNECT_DSH_BRIDGE_FD_IN:-}" ]; then
    # The SDK profile keeps interactions on the inherited Connect channel.
    # Native Web runs separately through Manager and retains its own Web profile.
    exec /opt/dsh/node_modules/.bin/dsh --patch "$HOME/.clawchat-dsh/models.patch.yml" "$@"
fi
exec /opt/dsh/node_modules/.bin/dsh "$@"
