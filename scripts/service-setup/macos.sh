#!/bin/sh
# Register metadata only; never install or run the service binary.
set -eu
exec node "$(dirname "$0")/../setup-service.mjs" --platform macos "$@"
