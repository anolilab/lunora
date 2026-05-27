#!/usr/bin/env bash
#
# Phase 5 verification gate: simulate a user who's never seen this repo.
#
# What this catches that the in-workspace `initSmoke.test.ts` cannot:
#   - `@cirrus/cli` ships with the right `files` whitelist (giget + the
#     bin shim + dist must all survive packing).
#   - The `bin/cirrus.mjs` shim + `tsx` loader still work when the cli is
#     installed flat under `node_modules/.bin/` outside any workspace.
#   - `cirrus init -t vite` then `cirrus codegen` runs end-to-end against
#     the freshly-scaffolded project using only the packed tarball.
#
# Templates now live at the monorepo root (`/templates/`) and are fetched
# remotely by giget at runtime. To keep this script offline-deterministic
# we invoke `cirrus init --from "$REPO_ROOT/templates"` so it copies from
# disk instead of hitting GitHub.
#
# What this does NOT cover:
#   - The remote giget fetch itself — that needs network + a published
#     template ref, covered by a separate online smoke once /templates
#     lands on the alpha branch.
#   - Booting the Vite + workerd dev server (requires a real Cloudflare
#     environment and a long-running process; covered manually).
#   - Installing the scaffold's @cirrus/* runtime deps from npm — none of
#     them are published yet.
#
# Exits non-zero on any failure. Output is verbose so CI logs explain
# where things broke.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRATCH="$(mktemp -d -t cirrus-clean-XXXXXX)"
trap 'rm -rf "$SCRATCH"' EXIT

PACK_DIR="$SCRATCH/tarballs"
INSTALL_DIR="$SCRATCH/install"
PROJECT_DIR="$SCRATCH/scaffold"

mkdir -p "$PACK_DIR" "$INSTALL_DIR"

echo "==> Packing @cirrus/cli + its workspace deps into $PACK_DIR"
# `pnpm pack` rebuilds the tarball with current source; we pack the cli
# plus everything its package.json depends on at workspace:* so they can
# resolve inside the standalone install.
for pkg in cirrus-cli cirrus-codegen cirrus-config cirrus-vite; do
    pushd "$REPO_ROOT/packages/$pkg" >/dev/null
    pnpm pack --pack-destination "$PACK_DIR" >/dev/null
    popd >/dev/null
done

cli_tgz="$(ls "$PACK_DIR"/cirrus-cli-*.tgz | head -n1)"
codegen_tgz="$(ls "$PACK_DIR"/cirrus-codegen-*.tgz | head -n1)"
config_tgz="$(ls "$PACK_DIR"/cirrus-config-*.tgz | head -n1)"
vite_tgz="$(ls "$PACK_DIR"/cirrus-vite-*.tgz | head -n1)"

echo "==> Installing @cirrus/cli into a standalone tmpdir"
cd "$INSTALL_DIR"
cat > package.json <<EOF
{
    "name": "cirrus-clean-smoke",
    "version": "0.0.0",
    "private": true,
    "dependencies": {
        "@cirrus/cli": "file:$cli_tgz"
    },
    "pnpm": {
        "overrides": {
            "@cirrus/codegen": "file:$codegen_tgz",
            "@cirrus/config": "file:$config_tgz",
            "@cirrus/vite": "file:$vite_tgz"
        }
    }
}
EOF

# `--ignore-workspace` because $SCRATCH may be inside the user's home and
# inherit a parent pnpm-workspace.yaml otherwise.
pnpm install --ignore-workspace --no-frozen-lockfile >/dev/null

echo "==> Sanity: the cli binary is on the path"
test -x node_modules/.bin/cirrus || {
    echo "ERROR: node_modules/.bin/cirrus missing after install"
    exit 1
}

echo "==> Sanity: monorepo templates root exists"
test -d "$REPO_ROOT/templates/vite" || {
    echo "ERROR: $REPO_ROOT/templates/vite missing — templates moved to monorepo root in this build"
    exit 1
}

echo "==> Running 'cirrus init -t vite --from $REPO_ROOT/templates' into $PROJECT_DIR"
mkdir -p "$(dirname "$PROJECT_DIR")"
cd "$(dirname "$PROJECT_DIR")"
"$INSTALL_DIR/node_modules/.bin/cirrus" init -t vite --from "$REPO_ROOT/templates" "$(basename "$PROJECT_DIR")"

echo "==> Asserting scaffold structure"
for required in \
    "$PROJECT_DIR/package.json" \
    "$PROJECT_DIR/wrangler.jsonc" \
    "$PROJECT_DIR/cirrus/schema.ts" \
    "$PROJECT_DIR/cirrus/messages.ts" \
    "$PROJECT_DIR/vite.config.ts" \
    "$PROJECT_DIR/tsconfig.json"; do
    if ! test -f "$required"; then
        echo "ERROR: scaffold missing $required"
        exit 1
    fi
done

echo "==> Running 'cirrus codegen' against the scaffold"
cd "$PROJECT_DIR"
"$INSTALL_DIR/node_modules/.bin/cirrus" codegen

for generated in cirrus/_generated/api.ts cirrus/_generated/dataModel.ts cirrus/_generated/server.ts; do
    if ! test -f "$PROJECT_DIR/$generated"; then
        echo "ERROR: codegen did not produce $generated"
        exit 1
    fi
done

echo
echo "OK — clean-machine smoke passed"
echo "  cli tarball: $cli_tgz"
echo "  scaffold:    $PROJECT_DIR"
