#!/usr/bin/env bash
#
# Template scaffold+install+build smoke matrix.
#
# For each of the 8 templates under templates/ this script:
#   1. Copies the template into a fresh scratch subdirectory.
#   2. Injects pnpm overrides that map every @cirrus/* dep to a local
#      packed tarball so pnpm install never touches the npm registry.
#   3. Runs `pnpm install`.
#   4. Runs `pnpm run build` (skipped with a notice if no build script).
#   5. Records PASS / XFAIL(expected failure) / XPASS(unexpected pass) / FAIL.
#
# Exit codes:
#   0  — all results were PASS or XFAIL
#   1  — at least one FAIL or XPASS
#
# Usage:
#   pnpm run test:templates                 # full matrix
#   ./scripts/template-build-smoke.sh       # same
#   ./scripts/template-build-smoke.sh vite  # single template (fast iteration)
#
# Scaffolding note: `cirrus init -t` only supports vite|standalone|tanstack-start
# (next is unfinished). All 8 templates are obtained by direct `cp -R` from the
# templates/ root — offline-deterministic, identical to what giget would produce.
# This avoids the isTemplate guard in init/handler.ts that falls back to "vite"
# for unsupported names.
#
# What this does NOT cover:
#   - The remote giget fetch path (needs network + a published template ref).
#   - Starting the Vite+workerd dev server (long-running, needs a real CF account).
#   - Running codegen on the scaffolded project (covered by clean-machine-smoke.sh).

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRATCH="$(mktemp -d -t cirrus-tmpl-XXXXXX)"
trap 'rm -rf "$SCRATCH"' EXIT

PACK_DIR="$SCRATCH/tarballs"
RESULTS_DIR="$SCRATCH/results"
mkdir -p "$PACK_DIR" "$RESULTS_DIR"

# ---------------------------------------------------------------------------
# Optional: single-template filter (first positional arg).
# ---------------------------------------------------------------------------
ONLY_TEMPLATE="${1:-}"

# ---------------------------------------------------------------------------
# Expected-fail list.
# Templates in this array must fail their BUILD step (scaffold+install must
# still pass). Any template NOT in this list that fails build is a FAIL.
# Any template IN this list that passes build is an XPASS (also a failure —
# remove it from the list when the fix lands).
# ---------------------------------------------------------------------------
# astro: `astro build` fails offline — the Astro CLI fetches integration
# metadata over the network during the build (network call to the integrations
# registry, not a template defect). Builds fine with network access.
#
# solid-start: `vinxi build` succeeds through the SSR/client/server-fns phases
# but fails at the Nitro packaging step with ENOENT for the client Vite manifest
# (.vinxi/build/client/_build/.vite/manifest.json). Root cause: @solidjs/start
# sets router.base="/_build" but with nitropack@2.13.x the manifest ends up at
# _build/client/.vite/manifest.json (extra router-name subdir). This is a
# framework-level incompatibility between @solidjs/start + nitropack + Vite 6;
# not fixable at the template config level without changing packages/.
XFAIL_BUILD=(astro solid-start)

# ---------------------------------------------------------------------------
# Discover templates (dynamic, so adding a new dir is automatically included).
# ---------------------------------------------------------------------------
TEMPLATES=()
for t_dir in "$REPO_ROOT/templates"/*/; do
    tname="$(basename "$t_dir")"
    TEMPLATES+=("$tname")
done

if [[ ${#TEMPLATES[@]} -eq 0 ]]; then
    echo "ERROR: no template directories found under $REPO_ROOT/templates/" >&2
    exit 1
fi

echo "==> Discovered ${#TEMPLATES[@]} templates: ${TEMPLATES[*]}"

# ---------------------------------------------------------------------------
# Step 1: Pack all @cirrus/* packages once.
# ---------------------------------------------------------------------------
echo "==> Packing all @cirrus/* workspace packages into $PACK_DIR"
for pkg_dir in "$REPO_ROOT"/packages/*/; do
    pkg_name="$(node -e "try{process.stdout.write(require('$pkg_dir/package.json').name||'')}catch{}" 2>/dev/null)"
    if [[ "$pkg_name" == @cirrus/* ]]; then
        pushd "$pkg_dir" >/dev/null
        pnpm pack --pack-destination "$PACK_DIR" >/dev/null
        popd >/dev/null
    fi
done

tgz_count="$(ls "$PACK_DIR"/*.tgz 2>/dev/null | wc -l | tr -d ' ')"
echo "==> Packed $tgz_count tarballs"

# Build the YAML overrides block once (shared across all templates).
OVERRIDES_YAML="$(node -e "
const fs = require('fs');
const path = require('path');
const dir = '$PACK_DIR';
const lines = fs.readdirSync(dir)
  .filter(f => f.endsWith('.tgz'))
  .map(f => {
    const base = f.replace(/-[0-9]+\.[0-9]+\.[0-9]+\.tgz\$/, '');
    const scope = base.replace(/^cirrus-/, '@cirrus/');
    return '  \"' + scope + '\": \"file:' + path.join(dir, f) + '\"';
  });
process.stdout.write(lines.join('\n'));
")"

# ---------------------------------------------------------------------------
# Helper: inject @cirrus/* overrides into a scaffold directory.
# ---------------------------------------------------------------------------
inject_overrides() {
    local scaffold_dir="$1"
    # Write pnpm-workspace.yaml (pnpm 11: overrides live here, not in package.json).
    # allowBuilds: permit native postinstall scripts that framework tools need
    # (esbuild, workerd, sharp). Without this pnpm 11 refuses to run them and
    # the subsequent `vite build` / `wrangler` invocations fail.
    cat > "$scaffold_dir/pnpm-workspace.yaml" <<WSEOF
packages: []
overrides:
$OVERRIDES_YAML

allowBuilds:
  "@parcel/watcher": true
  esbuild: true
  workerd: true
  sharp: true
WSEOF
}

# ---------------------------------------------------------------------------
# Helper: is a template in XFAIL_BUILD?
# ---------------------------------------------------------------------------
is_xfail() {
    local name="$1"
    for xf in "${XFAIL_BUILD[@]}"; do
        [[ "$xf" == "$name" ]] && return 0
    done
    return 1
}

# ---------------------------------------------------------------------------
# Result accumulators.
# ---------------------------------------------------------------------------
PASS=()
FAIL=()
XFAIL=()
XPASS=()
SKIP_BUILD=()

# ---------------------------------------------------------------------------
# Per-template loop.
# ---------------------------------------------------------------------------
for tname in "${TEMPLATES[@]}"; do
    # Single-template filter.
    if [[ -n "$ONLY_TEMPLATE" && "$ONLY_TEMPLATE" != "$tname" ]]; then
        continue
    fi

    echo ""
    echo "==========[ $tname ]=========="

    src_dir="$REPO_ROOT/templates/$tname"
    scaffold_dir="$SCRATCH/scaffolds/$tname"
    mkdir -p "$scaffold_dir"

    # -- Scaffold (copy template) -------------------------------------------
    echo "  ==> scaffold: cp -R $src_dir/ $scaffold_dir"
    cp -R "$src_dir/." "$scaffold_dir/"

    # Replace {{name}} placeholder (matches what cirrus init does).
    # Includes .vue and .svelte files so framework-specific templates that
    # embed {{name}} in their component markup are correctly substituted.
    find "$scaffold_dir" -type f \( -name "*.json" -o -name "*.jsonc" -o -name "*.ts" -o -name "*.tsx" -o -name "*.js" -o -name "*.mjs" -o -name "*.html" -o -name "*.md" -o -name "*.vue" -o -name "*.svelte" \) \
        -exec sed -i '' 's/{{name}}/'"$tname"'-app/g' {} \; 2>/dev/null || true

    # -- Inject overrides ---------------------------------------------------
    inject_overrides "$scaffold_dir"

    # -- pnpm install -------------------------------------------------------
    echo "  ==> pnpm install"
    install_log="$RESULTS_DIR/${tname}-install.log"
    if ! (cd "$scaffold_dir" && pnpm install --no-frozen-lockfile 2>&1) > "$install_log"; then
        echo "  FAIL: pnpm install failed for $tname (see $install_log)"
        tail -20 "$install_log" | sed 's/^/    /'
        FAIL+=("$tname(install)")
        continue
    fi
    echo "  ==> install OK"

    # -- pnpm run build -----------------------------------------------------
    build_script="$(node -e "
        try {
            const p = require('$scaffold_dir/package.json');
            process.stdout.write(p.scripts && p.scripts.build ? 'yes' : 'no');
        } catch { process.stdout.write('no'); }
    " 2>/dev/null)"

    if [[ "$build_script" != "yes" ]]; then
        echo "  ==> NOTICE: no build script in $tname — skipping build"
        SKIP_BUILD+=("$tname")
        PASS+=("$tname")
        continue
    fi

    echo "  ==> pnpm run build"
    build_log="$RESULTS_DIR/${tname}-build.log"
    build_exit=0
    # Run build inside the scaffold dir.
    (cd "$scaffold_dir" && pnpm run build 2>&1) > "$build_log" || build_exit=$?

    if [[ $build_exit -eq 0 ]]; then
        # Build passed.
        if is_xfail "$tname"; then
            echo "  XPASS: $tname was expected to fail but passed — remove from XFAIL_BUILD"
            XPASS+=("$tname")
        else
            echo "  PASS: $tname"
            PASS+=("$tname")
        fi
    else
        # Build failed.
        if is_xfail "$tname"; then
            echo "  XFAIL: $tname (expected — see XFAIL_BUILD comment)"
            XFAIL+=("$tname")
        else
            echo "  FAIL: $tname (unexpected build failure, exit $build_exit)"
            tail -30 "$build_log" | sed 's/^/    /'
            FAIL+=("$tname")
        fi
    fi
done

# ---------------------------------------------------------------------------
# Summary table.
# ---------------------------------------------------------------------------
echo ""
echo "====== Template build smoke summary ======"
printf "%-20s  %s\n" "TEMPLATE" "RESULT"
printf "%-20s  %s\n" "--------" "------"
for t in "${TEMPLATES[@]}"; do
    if [[ -n "$ONLY_TEMPLATE" && "$ONLY_TEMPLATE" != "$t" ]]; then
        continue
    fi
    result="unknown"
    for p in "${PASS[@]+"${PASS[@]}"}"; do [[ "$p" == "$t" ]] && result="PASS" && break; done
    for f in "${FAIL[@]+"${FAIL[@]}"}"; do [[ "$f" == "${t}(install)" ]] && result="FAIL(install)" && break; done
    for f in "${FAIL[@]+"${FAIL[@]}"}"; do [[ "$f" == "$t" ]] && result="FAIL(build)" && break; done
    for x in "${XFAIL[@]+"${XFAIL[@]}"}"; do [[ "$x" == "$t" ]] && result="XFAIL(expected)" && break; done
    for x in "${XPASS[@]+"${XPASS[@]}"}"; do [[ "$x" == "$t" ]] && result="XPASS(unexpected)" && break; done
    printf "%-20s  %s\n" "$t" "$result"
done
echo ""
echo "  PASS     : ${#PASS[@]}   (${PASS[*]+${PASS[*]}})"
echo "  XFAIL    : ${#XFAIL[@]}  (${XFAIL[*]+${XFAIL[*]}})"
echo "  FAIL     : ${#FAIL[@]}   (${FAIL[*]+${FAIL[*]}})"
echo "  XPASS    : ${#XPASS[@]}  (${XPASS[*]+${XPASS[*]}})"

# ---------------------------------------------------------------------------
# Exit code.
# ---------------------------------------------------------------------------
if [[ ${#FAIL[@]} -gt 0 ]]; then
    echo ""
    echo "FAILED — unexpected build/install failures: ${FAIL[*]+${FAIL[*]}}"
    exit 1
fi

if [[ ${#XPASS[@]} -gt 0 ]]; then
    echo ""
    echo "FAILED — unexpected passes (remove from XFAIL_BUILD): ${XPASS[*]+${XPASS[*]}}"
    exit 1
fi

echo ""
echo "OK — template build smoke passed (${#PASS[@]} pass, ${#XFAIL[@]} xfail)"
