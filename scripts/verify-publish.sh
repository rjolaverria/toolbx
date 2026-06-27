#!/usr/bin/env bash
# End-to-end verification of the PUBLISHED package shape, using a throwaway local
# npm registry (verdaccio). This proves what `npm pack` of a single package can't:
# that the four @toolbx/* packages publish together, that pnpm rewrites their
# workspace:^ refs to real versions, that `npx @toolbx/cli` resolves the whole
# dependency tree from a clean install, and that the custom-tools sandbox (which
# spawns a child harness and re-imports modules from disk) works from the
# installed on-disk layout.
#
# Usage: scripts/verify-publish.sh
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# Derive the candidate version from the workspace so this verifier validates
# whatever is about to be released, not a hardcoded one. All four packages
# share a single version and are published in lockstep (see RELEASING.md).
VERSION="$(node -p "require('$REPO_ROOT/apps/cli/package.json').version")"
PORT=4873
REGISTRY="http://localhost:${PORT}/"
WORK="$(mktemp -d)"
STORAGE="$WORK/verdaccio-storage"
CONFIG="$WORK/verdaccio.yaml"
PREFIX="$WORK/prefix"
mkdir -p "$STORAGE" "$PREFIX"

VERDACCIO_PID=""
cleanup() {
  [[ -n "$VERDACCIO_PID" ]] && kill "$VERDACCIO_PID" >/dev/null 2>&1 || true
  PATH="$PREFIX/bin:$PATH" TOOLBX_CONFIG="$WORK/config.json" tlbx stop >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

# Anonymous publish + read for the @toolbx scope; everything else proxies npmjs.
cat > "$CONFIG" <<YAML
storage: $STORAGE
uplinks:
  npmjs:
    url: https://registry.npmjs.org/
packages:
  '@toolbx/*':
    access: \$all
    publish: \$all
  '**':
    access: \$all
    publish: \$all
    proxy: npmjs
log: { type: stdout, format: pretty, level: warn }
YAML

echo "▶ starting verdaccio on $REGISTRY"
npx -y verdaccio@6 --listen "$PORT" --config "$CONFIG" >"$WORK/verdaccio.log" 2>&1 &
VERDACCIO_PID=$!

# Wait for the registry to answer.
for _ in $(seq 1 60); do
  if curl -fsS "$REGISTRY" >/dev/null 2>&1; then break; fi
  sleep 0.5
done
curl -fsS "$REGISTRY" >/dev/null 2>&1 || { echo "✗ verdaccio did not start"; cat "$WORK/verdaccio.log"; exit 1; }
echo "  ✓ verdaccio up"

# A fake auth token: verdaccio accepts it for anonymous publish, npm just needs one present.
export NPM_CONFIG_USERCONFIG="$WORK/.npmrc"
{
  echo "registry=$REGISTRY"
  echo "//localhost:${PORT}/:_authToken=fake-token-for-local-verdaccio"
} > "$NPM_CONFIG_USERCONFIG"

echo "▶ building and publishing all @toolbx packages to the local registry"
( cd "$REPO_ROOT" && pnpm build >/dev/null )
# pnpm rewrites workspace:^ -> the real version on publish.
( cd "$REPO_ROOT" && pnpm -r publish --registry "$REGISTRY" --no-git-checks >/dev/null )
rm -f "$REPO_ROOT/pnpm-publish-summary.json"
echo "  ✓ published the four @toolbx packages @ $VERSION"

echo "▶ clean global install of @toolbx/cli from the local registry"
export NPM_CONFIG_PREFIX="$PREFIX"
export TOOLBX_CONFIG="$WORK/config.json"
export PATH="$PREFIX/bin:$PATH"
npm install -g --registry "$REGISTRY" "@toolbx/cli@$VERSION"

fail() { echo "✗ FAIL: $1" >&2; exit 1; }
pass() { echo "  ✓ $1"; }

echo "▶ tlbx resolves the whole dependency tree"
tlbx --version >/dev/null || fail "tlbx --version"
pass "version: $(tlbx --version)"

tlbx init >/dev/null || fail "init"
tlbx config set server.http.port 7796 >/dev/null || fail "config set"
pass "init"

echo "▶ upstream round-trip through the auto-started daemon"
FIXTURE="$REPO_ROOT/apps/cli/test/integration/__fixtures__/named-tool-server.mjs"
tlbx server add-stdio echo -- node "$FIXTURE" >/dev/null || fail "server add-stdio"
OUT="$(tlbx run echo__echo --json '{"message":"published-ok"}' --output json)"
echo "$OUT" | grep -q "published-ok" || fail "upstream round-trip: $OUT"
pass "upstream tools/call"

echo "▶ custom tool: the path that bundling broke — import, enable, list, run"
cat > "$WORK/adder.ts" <<'TS'
/**
 * @toolbx-tool name add
 * @toolbx-tool title Add
 * @toolbx-tool description Adds two numbers.
 * @toolbx-tool namespace math
 */
export const inputSchema = {
  type: 'object',
  properties: { a: { type: 'number' }, b: { type: 'number' } },
  required: ['a', 'b'],
  additionalProperties: false,
};
export default function add(input) {
  return { content: [{ type: 'text', text: String(input.a + input.b) }] };
}
TS
tlbx tool import "$WORK/adder.ts" --yes >/dev/null || fail "tool import"
tlbx tool enable math__add >/dev/null || fail "tool enable"
tlbx stop >/dev/null 2>&1 || true
LIST="$(tlbx run --list --output json)"
echo "$LIST" | grep -q "math__add" || fail "custom tool not listed (sandbox load failed): $LIST"
ADD="$(tlbx run math__add --json '{"a":40,"b":2}' --output json)"
echo "$ADD" | grep -q '"42"' || fail "custom tool did not run: $ADD"
pass "custom tool import → list → run (sandbox works from installed layout)"

tlbx stop >/dev/null 2>&1 || true
echo "✓ PUBLISHED SHAPE VERIFIED — npx @toolbx/cli works end-to-end from a clean install"
