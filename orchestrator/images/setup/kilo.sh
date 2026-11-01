#!/usr/bin/env bash
# Sandbox setup: install Kilo Code CLI (pinned version) system-wide in a fresh worker sandbox.
# Not preinstalled in the sandbox image.
# Usage (inside the VM):  bash kilo.sh [version]      default version = harnesses/registry.json pin
# Normally uploaded with _common.sh and run by the VM runner (orchestrator/core/runners.ts) when the pin is missing.
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=_common.sh
. "$HERE/_common.sh"
VERSION="${1:-${HARNESS_VERSION:-7.8.8}}"

npm_pin "@kilocode/cli" "$VERSION"

verify kilo kilo "$VERSION"
cleanup
