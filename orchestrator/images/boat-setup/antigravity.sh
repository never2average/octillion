#!/usr/bin/env bash
# boat.dev setup: install Google Antigravity CLI (agy) (pinned version) system-wide in a fresh boat VM, ready to snapshot.
# Not preinstalled on boat VMs (see https://docs.boat.dev/machines). Same tarball the official installer (https://antigravity.google/cli/install.sh) downloads, pinned by build id + sha512.
# Usage (inside the VM):  bash antigravity.sh [version]      default version = harnesses/registry.json pin
# Normally driven by ../boat-snapshot.sh, which uploads this + _common.sh, runs it and saves the named snapshot.
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=_common.sh
. "$HERE/_common.sh"
VERSION="${1:-${HARNESS_VERSION:-1.3.3}}"

# The installer resolves a "latest" manifest; we pin the build. Update AGY_BUILD and the sha512s together
# from https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests/linux_<amd64|arm64>.json
AGY_BUILD="${AGY_BUILD:-1.3.3-5524738307653632}"
case "$(linux_arch)" in
  x64)   P="linux-x64/cli_linux_x64.tar.gz";   SHA="${AGY_SHA512_AMD64:-abe3ddf5cf30d3adaa586acf505221aa19702f5ca71af3c8b1f9b1a5976bd8e5c151c41ea33b39c41675d25843462a3e8c382c054f580e9d7e1688919d3b5110}";;
  arm64) P="linux-arm/cli_linux_arm64.tar.gz"; SHA="${AGY_SHA512_ARM64:-1bfd3503576219a102176c13579665a2f39e84ac86a904b117d3b33f3dd751f194a862496bad6ffe914ad46d2c877ba12b6c07e6db07128b706d238262fe430c}";;
esac
case "$AGY_BUILD" in "$VERSION"-*) ;; *) die "AGY_BUILD $AGY_BUILD does not match version $VERSION";; esac
download_tarball "https://storage.googleapis.com/antigravity-public/antigravity-cli/${AGY_BUILD}/${P}" "/opt/agy/${AGY_BUILD}" "$SHA"
$SUDO ln -sfn "/opt/agy/${AGY_BUILD}/antigravity" /usr/local/bin/agy

verify antigravity agy "$VERSION"
cleanup
