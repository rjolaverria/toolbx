#!/usr/bin/env bash
# Clean-install smoke test for the published @toolbox/cli tarball.
#
# Installs the given tarball (or, with --from-npm, the published package) into a
# throwaway global prefix with an isolated config + cache, then drives the core
# user journeys exactly as an outside engineer's `npx`/global install would —
# proving the bundle's externalized deps all resolve from a real install tree.
#
# Usage:
#   scripts/verify-tarball.sh path/to/toolbox-cli-0.1.0.tgz
#   scripts/verify-tarball.sh --from-npm @toolbox/cli@0.1.0
#
# Env:
#   SKIP_KEYRING=1   install with optional deps disabled (keyring-absent path)
set -euo pipefail

SPEC="${1:?usage: verify-tarball.sh <tarball.tgz | --from-npm <pkgspec>>}"
FROM_NPM=0
if [[ "$SPEC" == "--from-npm" ]]; then
  FROM_NPM=1
  SPEC="${2:?--from-npm requires a package spec, e.g. @toolbox/cli@0.1.0}"
fi

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="$(mktemp -d)"
PREFIX="$WORK/prefix"
export NPM_CONFIG_PREFIX="$PREFIX"
export TOOLBOX_CONFIG="$WORK/config.json"
export PATH="$PREFIX/bin:$PATH"
mkdir -p "$PREFIX" "$WORK/upstream"

cleanup() {
  # Best-effort: stop any daemon this run started, then remove the temp tree.
  tlbx stop >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

INSTALL_FLAGS=()
if [[ "${SKIP_KEYRING:-0}" == "1" ]]; then
  INSTALL_FLAGS+=(--omit=optional)
fi

echo "▶ installing into $PREFIX ${SKIP_KEYRING:+(keyring-absent)}"
npm install -g ${INSTALL_FLAGS[@]+"${INSTALL_FLAGS[@]}"} "$SPEC"

fail() { echo "✗ FAIL: $1" >&2; exit 1; }
pass() { echo "  ✓ $1"; }

echo "▶ tlbx resolves and reports a version"
tlbx --version >/dev/null || fail "tlbx --version"
pass "version: $(tlbx --version)"

echo "▶ init"
tlbx init >/dev/null || fail "init"
# Use a private port so this never collides with a real daemon on 7331.
tlbx config set server.http.port 7793 >/dev/null || fail "config set port"
pass "init + config set"

echo "▶ add a real stdio upstream and inspect it live"
FIXTURE="$REPO_ROOT/apps/cli/test/integration/__fixtures__/named-tool-server.mjs"
tlbx server add-stdio echo -- node "$FIXTURE" >/dev/null || fail "server add-stdio"
tlbx server inspect echo 2>&1 | grep -q "status: connected" || fail "upstream did not connect"
pass "upstream connected, tools discovered"

echo "▶ run a tool end-to-end through the auto-started daemon"
OUT="$(tlbx run echo__echo --json '{"message":"tarball-ok"}' --output json)"
echo "$OUT" | grep -q "tarball-ok" || fail "tool call did not round-trip: $OUT"
pass "tools/call round-trip"

echo "▶ doctor"
tlbx doctor 2>&1 | grep -q "node-version" || fail "doctor"
pass "doctor ran"

echo "▶ stop"
tlbx stop >/dev/null 2>&1 || true
pass "stop"

echo "✓ ALL CHECKS PASSED for $SPEC"
