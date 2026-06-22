#!/usr/bin/env bash
#
# Phase 5 verification gate: simulate a user who's never seen this repo.
#
# What this catches that the in-workspace `initSmoke.test.ts` cannot:
#   - `@lunora/cli` ships with the right `files` whitelist (giget + the
#     bin shim + dist must all survive packing).
#   - The `bin/lunora.mjs` shim + `tsx` loader still work when the cli is
#     installed flat under `node_modules/.bin/` outside any workspace.
#   - `lunora init -t vite-react` then `lunora codegen` runs end-to-end against
#     the freshly-scaffolded project using only the packed tarball.
#
# Templates now live at the monorepo root (`/templates/`) and are fetched
# remotely by giget at runtime. To keep this script offline-deterministic
# we invoke `lunora init --from "$REPO_ROOT/templates"` so it copies from
# disk instead of hitting GitHub.
#
# What this does NOT cover:
#   - The remote giget fetch itself — that needs network + a published
#     template ref, covered by a separate online smoke once /templates
#     lands on the alpha branch.
#   - Booting the Vite + workerd dev server (requires a real Cloudflare
#     environment and a long-running process; covered manually).
#   - Installing the scaffold's @lunora/* runtime deps from npm — none of
#     them are published yet.
#
# Exits non-zero on any failure. Output is verbose so CI logs explain
# where things broke.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRATCH="$(mktemp -d -t lunora-clean-XXXXXX)"
trap 'rm -rf "$SCRATCH"' EXIT

PACK_DIR="$SCRATCH/tarballs"
INSTALL_DIR="$SCRATCH/install"
PROJECT_DIR="$SCRATCH/scaffold"

mkdir -p "$PACK_DIR" "$INSTALL_DIR"

echo "==> Packing all @lunora/* workspace packages into $PACK_DIR"
# Pack every package so we can map any @lunora/* dep a template (or the CLI
# itself) might pull to a local file: tarball instead of the npm registry.
for pkg_dir in "$REPO_ROOT"/packages/*/; do
    pkg_name="$(node -e "try{process.stdout.write(require('$pkg_dir/package.json').name||'')}catch{}" 2>/dev/null)"
    if [[ "$pkg_name" == @lunora/* ]]; then
        pushd "$pkg_dir" >/dev/null
        pnpm pack --pack-destination "$PACK_DIR" >/dev/null
        popd >/dev/null
    fi
done

cli_tgz="$(ls "$PACK_DIR"/lunora-cli-*.tgz | head -n1)"

# Build the pnpm-workspace.yaml overrides block (pnpm 11: overrides live in
# pnpm-workspace.yaml, not in the "pnpm" field of package.json).
OVERRIDES_YAML="$(node -e "
const fs = require('fs');
const path = require('path');
const dir = '$PACK_DIR';
const lines = fs.readdirSync(dir)
  .filter(f => f.endsWith('.tgz'))
  .map(f => {
    const base = f.replace(/-[0-9]+\.[0-9]+\.[0-9]+\.tgz\$/, '');
    const scope = base.replace(/^lunora-/, '@lunora/');
    return '  \"' + scope + '\": \"file:' + path.join(dir, f) + '\"';
  });
process.stdout.write(lines.join('\n'));
")"

echo "==> Installing @lunora/cli into a standalone tmpdir"
cd "$INSTALL_DIR"
cat > package.json <<EOF
{
    "name": "lunora-clean-smoke",
    "version": "0.0.0",
    "private": true,
    "dependencies": {
        "@lunora/cli": "file:$cli_tgz"
    }
}
EOF

# pnpm-workspace.yaml with overrides redirects all @lunora/* to packed tarballs.
cat > pnpm-workspace.yaml <<EOF
packages: []
overrides:
$OVERRIDES_YAML
EOF

pnpm install --no-frozen-lockfile >/dev/null

echo "==> Sanity: the cli binary is on the path"
test -x node_modules/.bin/lunora || {
    echo "ERROR: node_modules/.bin/lunora missing after install"
    exit 1
}

echo "==> Sanity: monorepo templates root exists"
test -d "$REPO_ROOT/templates/vite-react" || {
    echo "ERROR: $REPO_ROOT/templates/vite-react missing — templates moved to monorepo root in this build"
    exit 1
}

echo "==> Running 'lunora init -t vite-react --from $REPO_ROOT/templates' into $PROJECT_DIR"
mkdir -p "$(dirname "$PROJECT_DIR")"
cd "$(dirname "$PROJECT_DIR")"
"$INSTALL_DIR/node_modules/.bin/lunora" init -t vite-react --from "$REPO_ROOT/templates" "$(basename "$PROJECT_DIR")"

echo "==> Asserting scaffold structure"
for required in \
    "$PROJECT_DIR/package.json" \
    "$PROJECT_DIR/wrangler.jsonc" \
    "$PROJECT_DIR/lunora/schema.ts" \
    "$PROJECT_DIR/lunora/messages.ts" \
    "$PROJECT_DIR/vite.config.ts" \
    "$PROJECT_DIR/tsconfig.json"; do
    if ! test -f "$required"; then
        echo "ERROR: scaffold missing $required"
        exit 1
    fi
done

echo "==> Running 'lunora codegen' against the scaffold"
cd "$PROJECT_DIR"
"$INSTALL_DIR/node_modules/.bin/lunora" codegen

for generated in lunora/_generated/api.ts lunora/_generated/dataModel.ts lunora/_generated/server.ts; do
    if ! test -f "$PROJECT_DIR/$generated"; then
        echo "ERROR: codegen did not produce $generated"
        exit 1
    fi
done

echo
echo "OK — clean-machine smoke passed"
echo "  cli tarball: $cli_tgz"
echo "  scaffold:    $PROJECT_DIR"
