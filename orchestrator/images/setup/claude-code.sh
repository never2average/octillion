#!/usr/bin/env bash
# Sandbox setup: install Claude Code (pinned version) system-wide in a fresh worker sandbox.
# A preinstalled copy, if any, is replaced by our pinned one.
# Usage (inside the VM):  bash claude-code.sh [version]      default version = harnesses/registry.json pin
# Normally uploaded with _common.sh and run by the VM runner (orchestrator/core/runners.ts) when the pin is missing.
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=_common.sh
. "$HERE/_common.sh"
VERSION="${1:-${HARNESS_VERSION:-2.1.296}}"

npm_pin "@anthropic-ai/claude-code" "$VERSION"

verify claude-code claude "$VERSION"
cleanup
