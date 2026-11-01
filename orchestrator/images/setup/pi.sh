#!/usr/bin/env bash
# Sandbox setup: install Pi coding agent (pinned version) system-wide in a fresh worker sandbox.
# A preinstalled copy, if any, is replaced by our pinned one. Package is @earendil-works/pi-coding-agent (the @mariozechner name is deprecated).
# Usage (inside the VM):  bash pi.sh [version]      default version = harnesses/registry.json pin
# Normally uploaded with _common.sh and run by the VM runner (orchestrator/core/runners.ts) when the pin is missing.
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=_common.sh
. "$HERE/_common.sh"
VERSION="${1:-${HARNESS_VERSION:-1.1.0}}"

# --ignore-scripts as in the official npm instructions.
npm_pin "@earendil-works/pi-coding-agent" "$VERSION" --ignore-scripts

verify pi pi "$VERSION"
cleanup
