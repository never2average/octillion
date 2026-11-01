#!/usr/bin/env bash
# Sandbox setup: install GitHub Copilot CLI (pinned version) system-wide in a fresh worker sandbox.
# Not preinstalled in the sandbox image.
# Usage (inside the VM):  bash copilot.sh [version]      default version = harnesses/registry.json pin
# Normally uploaded with _common.sh and run by the VM runner (orchestrator/core/runners.ts) when the pin is missing.
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=_common.sh
. "$HERE/_common.sh"
VERSION="${1:-${HARNESS_VERSION:-1.0.95}}"

npm_pin "@github/copilot" "$VERSION"

verify copilot copilot "$VERSION"
cleanup
