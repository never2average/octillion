#!/usr/bin/env bash
# Sandbox setup: install Cursor CLI (cursor-agent) (pinned version) system-wide in a fresh worker sandbox.
# A preinstalled copy, if any, is replaced by our pinned one. Same tarball the official installer (https://cursor.com/install) downloads, pinned by build id.
# Usage (inside the VM):  bash cursor.sh [version]      default version = harnesses/registry.json pin
# Normally uploaded with _common.sh and run by the VM runner (orchestrator/core/runners.ts) when the pin is missing.
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=_common.sh
. "$HERE/_common.sh"
VERSION="${1:-${HARNESS_VERSION:-2026.10.01-e373342}}"

ARCH="$(linux_arch)"
download_tarball "https://downloads.cursor.com/lab/${VERSION}/linux/${ARCH}/agent-cli-package.tar.gz" \
  "/opt/cursor-agent/${VERSION}" "" --strip-components=1
$SUDO ln -sfn "/opt/cursor-agent/${VERSION}/cursor-agent" /usr/local/bin/cursor-agent
$SUDO ln -sfn "/opt/cursor-agent/${VERSION}/cursor-agent" /usr/local/bin/agent

verify cursor cursor-agent "$VERSION"
cleanup
