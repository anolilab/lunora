#!/usr/bin/env bash
#
# Phase 5 verification gate: simulate a user who's never seen this repo.
#
# What this catches that the in-workspace `initSmoke.test.ts` cannot:
#   - `@lunora/cli` ships with the right `files` whitelist (giget + the
#     bin shim + dist must all survive packing).
#   - The `bin/lunora.mjs` shim + `tsx` loader still work when the cli is
#     installed flat under `node_modules/.bin/` outside any workspace.
#   - `lunora init -t tanstack-start-react` then `lunora codegen` runs end-to-end against
#     the freshly-scaffolded project using only the packed tarball.
#
# Templates now live at the monorepo root (`/templates/`) and are fetched
# remotely by giget at runtime. To keep this script offline-deterministic
# we invoke `lunora init --from "$REPO_ROOT/templates"` so it copies from
# disk instead of hitting GitHub.
#
# What this does NOT cover:
#   - The remote giget fetch itself — that needs network + a published
#     template ref. `/templates` is on the branch now and there is still no
#     online smoke, so this remains uncovered by anything.
#   - Booting the Vite + workerd dev server (requires a real Cloudflare
#     environment and a long-running process; covered manually).
#   - Installing the scaffold's @lunora/* runtime deps from npm. They ARE
#     published (the `alpha` dist-tag), but this script deliberately resolves
#     them from the packed local tarballs so a run is offline-deterministic
#     and tests THIS tree rather than the last release.
#
# `pnpm run test:clean-machine`, and only that: this script is in no workflow,
# so nothing here runs in CI.
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

echo "==> Packing all @lunora/* + lunorash workspace packages into $PACK_DIR"
# Pack every package so we can map any base-package dep a template (or the CLI
# itself) might pull to a local file: tarball instead of the npm registry.
#
# Record each real package name -> its tarball in a manifest, and key the
# overrides off THAT rather than off a filename regex. The regex here only
# matched a plain X.Y.Z, so every `1.0.0-alpha.N` tarball — which is all of them —
# produced a key like `@lunora/cli-1.0.0-alpha.208.tgz`: a package name that does
# not exist, an override that matches nothing, and every transitive base package
# quietly resolved from npm. The script then "passed" while testing the PUBLISHED
# packages instead of this checkout. `scripts/template-build-smoke.sh` hit the
# same trap and this is its fix.
PACK_MANIFEST="$SCRATCH/pack-manifest.tsv"
: > "$PACK_MANIFEST"

for pkg_dir in "$REPO_ROOT"/packages/*/; do
    pkg_name="$(node -e "try{process.stdout.write(require('$pkg_dir/package.json').name||'')}catch{}" 2>/dev/null)"
    if [[ "$pkg_name" == @lunora/* || "$pkg_name" == "lunorash" ]]; then
        pushd "$pkg_dir" >/dev/null
        # `pnpm pack --pack-destination` prints the created tarball path on its
        # last output line; normalize to an absolute path under PACK_DIR.
        tarball_out="$(pnpm pack --pack-destination "$PACK_DIR" | tail -1)"
        popd >/dev/null
        printf '%s\t%s\n' "$pkg_name" "$PACK_DIR/$(basename "$tarball_out")" >> "$PACK_MANIFEST"
    fi
done

cli_tgz="$(awk -F'\t' '$1 == "@lunora/cli" { print $2 }' "$PACK_MANIFEST")"

if [[ -z "$cli_tgz" || ! -f "$cli_tgz" ]]; then
    echo "ERROR: no @lunora/cli tarball was packed — nothing to smoke-test" >&2
    exit 1
fi

# Build the pnpm-workspace.yaml overrides block (pnpm 11: overrides live in
# pnpm-workspace.yaml, not in the "pnpm" field of package.json) from the
# name -> tarball manifest, so every base package resolves locally at any version.
OVERRIDES_YAML="$(node -e "
const fs = require('fs');
const rows = fs.readFileSync('$PACK_MANIFEST', 'utf8').trim().split('\n').filter(Boolean);
const lines = rows.map((row) => {
    const [name, file] = row.split('\t');
    return '  \"' + name + '\": \"file:' + file + '\"';
});
process.stdout.write(lines.join('\n'));
")"

if [[ -z "$OVERRIDES_YAML" ]]; then
    echo "ERROR: the overrides block is empty — every @lunora/* dep would come from npm" >&2
    exit 1
fi

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

# The overrides are only worth anything if they were actually applied. A base
# package resolved from the npm registry means this run tested the PUBLISHED
# package, not this checkout — the exact failure the bogus override keys caused,
# and one that looks identical to success from the outside.
echo "==> Sanity: no base package resolved from the npm registry"
if [[ -f pnpm-lock.yaml ]]; then
    # `tr -d` rather than a `?` quantifier: BSD's basic regex has none. The `(...)`
    # peer-resolved suffix is excluded so one package is reported once.
    leaked="$(grep -oE "^  '?(@lunora/[a-z0-9-]+|lunorash)@[0-9][^'(:]*" pnpm-lock.yaml | tr -d " '" | sort -u || true)"

    if [[ -n "$leaked" ]]; then
        echo "ERROR: these base packages came from the registry instead of the packed tarballs:" >&2
        echo "$leaked" | sed 's/^/    /' >&2
        exit 1
    fi
else
    echo "ERROR: no pnpm-lock.yaml after install — cannot prove the overrides applied" >&2
    exit 1
fi

echo "==> Sanity: the cli binary is on the path"
test -x node_modules/.bin/lunora || {
    echo "ERROR: node_modules/.bin/lunora missing after install"
    exit 1
}

echo "==> Sanity: monorepo templates root exists"
test -d "$REPO_ROOT/templates/tanstack-start-react" || {
    echo "ERROR: $REPO_ROOT/templates/tanstack-start-react missing — templates moved to monorepo root in this build"
    exit 1
}

echo "==> Running 'lunora init -t tanstack-start-react --from $REPO_ROOT/templates' into $PROJECT_DIR"
mkdir -p "$(dirname "$PROJECT_DIR")"
cd "$(dirname "$PROJECT_DIR")"
"$INSTALL_DIR/node_modules/.bin/lunora" init -t tanstack-start-react --from "$REPO_ROOT/templates" "$(basename "$PROJECT_DIR")"

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
