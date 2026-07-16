#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
APP_EXECUTABLE=${RAINTOOL_ELECTRON_EXECUTABLE:-"$SCRIPT_DIR/../../MacOS/RainTool"}

if [ ! -x "$APP_EXECUTABLE" ]; then
  echo "RainTool executable not found: $APP_EXECUTABLE" >&2
  exit 1
fi

export ELECTRON_RUN_AS_NODE=1
exec "$APP_EXECUTABLE" "$SCRIPT_DIR/index.cjs" "$@"
