#!/bin/sh
set -eu

DATA_DIR=/app/data
mkdir -p "$DATA_DIR"
# Keep an allowlist file on the volume so /check and the readiness check have something to read.
[ -f "$DATA_DIR/eligible-addresses.json" ] || echo '{"addresses":[]}' > "$DATA_DIR/eligible-addresses.json"
chown -R node:node "$DATA_DIR"

exec gosu node "$@"
