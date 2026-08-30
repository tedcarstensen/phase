#!/bin/sh
set -eu

: "${PHASE_DATA_DIR:=/var/lib/phase-server}"
export PHASE_DATA_DIR

mkdir -p "$PHASE_DATA_DIR"
chown phase:phase "$PHASE_DATA_DIR"

# Images built with FRONTEND_STAGE=frontend carry the web client at
# /srv/phase-client; server-only images carry an empty directory there. Keying
# off index.html rather than the directory means one entrypoint serves both, and
# an operator who sets PHASE_STATIC_DIR (or --static-dir) still wins.
if [ -z "${PHASE_STATIC_DIR:-}" ] && [ -f /srv/phase-client/index.html ]; then
    PHASE_STATIC_DIR=/srv/phase-client
    export PHASE_STATIC_DIR
fi

if [ $# -eq 0 ]; then
    set -- phase-server
elif [ "${1#-}" != "$1" ]; then
    set -- phase-server "$@"
fi

exec gosu phase "$@"
