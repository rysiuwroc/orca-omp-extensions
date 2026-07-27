#!/bin/sh
# Install the Orca OMP extensions for the current user.
set -eu

SCRIPT_DIR=$(CDPATH= cd "$(dirname "$0")" && pwd)
TARGET_DIR=${HOME}/.omp/agent/extensions

mkdir -p "$TARGET_DIR"
for file in \
    orca-agent-status.ts \
    orca-titlebar-spinner.ts \
    orca-prefill.ts
do
    cp "$SCRIPT_DIR/$file" "$TARGET_DIR/$file"
done

printf 'Installed Orca OMP extensions to %s\n' "$TARGET_DIR"
