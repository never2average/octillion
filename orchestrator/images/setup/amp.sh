#!/usr/bin/env bash
# Sandbox setup: install Amp CLI (pinned version) system-wide in a fresh worker sandbox.
# Not preinstalled in the sandbox image. npm name is @ampcode/cli (@sourcegraph/amp is the old name).
# Usage (inside the VM):  bash amp.sh [version]      default version = harnesses/registry.json pin
# Normally uploaded with _common.sh and run by the VM runner (orchestrator/core/runners.ts) when the pin is missing.
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=_common.sh
. "$HERE/_common.sh"
VERSION="${1:-${HARNESS_VERSION:-0.0.1791619249-g722a12}}"

npm_pin "@ampcode/cli" "$VERSION"

verify amp amp "$VERSION"
cleanup
