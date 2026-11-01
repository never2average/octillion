#!/usr/bin/env bash
# Sandbox setup: install OpenAI Codex CLI (pinned version) system-wide in a fresh worker sandbox.
# A preinstalled copy, if any, is replaced by our pinned one.
# Usage (inside the VM):  bash codex.sh [version]      default version = harnesses/registry.json pin
# Normally uploaded with _common.sh and run by the VM runner (orchestrator/core/runners.ts) when the pin is missing.
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=_common.sh
. "$HERE/_common.sh"
VERSION="${1:-${HARNESS_VERSION:-0.162.1}}"

npm_pin "@openai/codex" "$VERSION"

verify codex codex "$VERSION"
cleanup
