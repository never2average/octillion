#!/usr/bin/env bash
# Sandbox setup: install Factory droid (pinned version) system-wide in a fresh worker sandbox.
# Not preinstalled in the sandbox image. Same binary as https://app.factory.ai/cli, via the official npm package `droid`.
# Usage (inside the VM):  bash droid.sh [version]      default version = harnesses/registry.json pin
# Normally uploaded with _common.sh and run by the VM runner (orchestrator/core/runners.ts) when the pin is missing.
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=_common.sh
. "$HERE/_common.sh"
VERSION="${1:-${HARNESS_VERSION:-0.238.0}}"

npm_pin "droid" "$VERSION"

verify droid droid "$VERSION"
cleanup
