#!/usr/bin/env bash
#
# Template scaffold+install+build smoke matrix.
#
# For each worker-toolchain template under templates/ (all except SKIP_TEMPLATES)
# this script:
#   1. Copies the template into a fresh scratch subdirectory.
#   2. Injects pnpm overrides that map every @lunora/* dep to a local
#      packed tarball so pnpm install never touches the npm registry.
#   3. Runs `pnpm install`.
#   4. For React templates, runs `lunora add auth-ui` and asserts the copy-in
#      screens landed and their deps were injected (then re-installs).
#   5. Runs `pnpm run build` (skipped with a notice if no build script) — which
#      is what proves the copied auth screens actually compile in a real app.
#   5. Records PASS / XFAIL(expected failure) / XPASS(unexpected pass) / FAIL.
#
# Exit codes:
#   0  — all results were PASS or XFAIL
#   1  — at least one FAIL or XPASS
#
# Usage:
#   pnpm run test:templates                 # full matrix
#   ./scripts/template-build-smoke.sh       # same
#   ./scripts/template-build-smoke.sh tanstack-start-react  # single template (fast iteration)
#
# Scaffolding note: `lunora init -t` only supports vite|standalone|tanstack-start
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

# Disable Astro's anonymous telemetry ping (telemetry.astro.build) so the build
# is fully offline-deterministic. Harmless for the other frameworks. (Note: the
# astro template's actual offline-build fix was running `lunora codegen` before
# `astro build` in its build script — the @lunora/astro integration, unlike the
# Vite plugin, does not run codegen itself.)
export ASTRO_TELEMETRY_DISABLED=1

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRATCH="$(mktemp -d -t lunora-tmpl-XXXXXX)"
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
# (react-router + solid-start templates were removed: their build tools
# (@react-router/dev, vinxi/@solidjs/start) only support Vite <=7 while Lunora
# is standardized on Vite 8 — see the official CF react-router starter which
# pins vite ^7. Re-add the templates when those frameworks ship Vite 8 support.)
XFAIL_BUILD=()

# ---------------------------------------------------------------------------
# Templates excluded from this worker-toolchain smoke matrix.
# The Expo template is a React Native (Metro) app, not a Vite/workerd project:
# its `pnpm install` pulls a different, largely-native toolchain (react-native,
# expo) that isn't represented by the allowBuilds list below, and it has no
# `pnpm run build` step. It's validated separately by the CLI init smoke test
# (scaffold → `lunora codegen` → `tsc`), mirroring how examples/expo is checked.
# ---------------------------------------------------------------------------
SKIP_TEMPLATES=("expo")

is_skipped() {
    local name="$1"
    for s in "${SKIP_TEMPLATES[@]+"${SKIP_TEMPLATES[@]}"}"; do
        [[ "$s" == "$name" ]] && return 0
    done
    return 1
}

# ---------------------------------------------------------------------------
# Discover templates (dynamic, so adding a new dir is automatically included).
# ---------------------------------------------------------------------------
TEMPLATES=()
for t_dir in "$REPO_ROOT/templates"/*/; do
    tname="$(basename "$t_dir")"
    if is_skipped "$tname"; then
        echo "==> Skipping $tname (not part of the worker-toolchain smoke matrix)"
        continue
    fi
    TEMPLATES+=("$tname")
done

if [[ ${#TEMPLATES[@]} -eq 0 ]]; then
    echo "ERROR: no template directories found under $REPO_ROOT/templates/" >&2
    exit 1
fi

echo "==> Discovered ${#TEMPLATES[@]} templates: ${TEMPLATES[*]}"

# ---------------------------------------------------------------------------
# Step 1: Pack all base packages the templates depend on, once.
# ---------------------------------------------------------------------------
# Pack every publishable base package the templates depend on: the `@lunora/*`
# scope AND the unscoped `lunorash` umbrella (dir `packages/lunora/`), which the
# templates depend on directly. Record each real package name → its tarball in a
# manifest so the overrides key off the authoritative name — NOT a filename
# regex, which can't recover a scoped/umbrella name and breaks on prerelease
# versions (`lunora-server-1.0.0-alpha.17.tgz` would map to a bogus key).
echo "==> Packing all @lunora/* + lunorash workspace packages into $PACK_DIR"
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

tgz_count="$(ls "$PACK_DIR"/*.tgz 2>/dev/null | wc -l | tr -d ' ')"
echo "==> Packed $tgz_count tarballs"

# Build the YAML overrides block once (shared across all templates) from the
# name→tarball manifest, so every base package (incl. `lunorash`) resolves to its
# local tarball instead of the registry, at any version.
OVERRIDES_YAML="$(node -e "
const fs = require('fs');
const rows = fs.readFileSync('$PACK_MANIFEST', 'utf8').trim().split('\n').filter(Boolean);
const lines = rows.map((row) => {
    const [name, file] = row.split('\t');
    return '  \"' + name + '\": \"file:' + file + '\"';
});
process.stdout.write(lines.join('\n'));
")"

# ---------------------------------------------------------------------------
# Helper: inject @lunora/* overrides into a scaffold directory.
# ---------------------------------------------------------------------------
inject_overrides() {
    local scaffold_dir="$1"
    # Write pnpm-workspace.yaml (pnpm 11: overrides live here, not in package.json).
    # allowBuilds: permit native postinstall scripts that framework tools need,
    # and deny the optional native builds a scaffold doesn't need (compiler-free).
    # Every build-script package in the tree must be listed (true or false) or
    # pnpm halts with ERR_PNPM_IGNORED_BUILDS. Kept in sync with the CLI init
    # handler's PNPM_BUILT_DEPENDENCIES + PNPM_DENIED_BUILD_DEPENDENCIES
    # (packages/cli/src/commands/init/handler.ts) — the list a real `lunora init`
    # scaffold ships.
    cat > "$scaffold_dir/pnpm-workspace.yaml" <<WSEOF
packages: []
overrides:
$OVERRIDES_YAML

allowBuilds:
  "@parcel/watcher": true
  esbuild: true
  lmdb: true
  msgpackr-extract: true
  rs-module-lexer: true
  sharp: true
  unrs-resolver: true
  workerd: true
  cpu-features: false
  protobufjs: false
  ssh2: false
WSEOF
}

# ---------------------------------------------------------------------------
# Helper: is a template in XFAIL_BUILD?
# ---------------------------------------------------------------------------
is_xfail() {
    local name="$1"
    # `${XFAIL_BUILD[@]+...}` guard so an empty array is safe under `set -u`.
    for xf in "${XFAIL_BUILD[@]+"${XFAIL_BUILD[@]}"}"; do
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

    # Replace {{name}} placeholder (matches what lunora init does).
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

    # -- lunora add auth-ui -------------------------------------------------
    # Only for React templates: the auth-ui payload is per-framework, and the
    # point here is that the copy lands and compiles inside a real scaffold —
    # the CLI's own tests copy into a bare fixture directory that never builds.
    if [[ -f "$scaffold_dir/package.json" ]] && node -e "
        const p = require('$scaffold_dir/package.json');
        const deps = { ...p.dependencies, ...p.devDependencies };
        process.exit(deps['@lunora/react'] || deps.react ? 0 : 1);
    " 2>/dev/null; then
        echo "  ==> lunora add auth-ui"
        authui_log="$RESULTS_DIR/${tname}-auth-ui.log"
        if ! (cd "$scaffold_dir" && node "$REPO_ROOT/packages/cli/dist/index.mjs" add auth-ui --yes --from "$REPO_ROOT/registry" 2>&1) > "$authui_log"; then
            echo "  FAIL: lunora add auth-ui failed for $tname (see $authui_log)"
            FAIL+=("$tname(auth-ui)")
            continue
        fi

        # The user-owned copy landed where the item promises…
        for expected in \
            "lunora/auth-ui/core/sign-in.ts" \
            "lunora/auth-ui/react/auth-cards.tsx" \
            "lunora/auth-ui/client.ts" \
            "lunora/auth-ui/styles.css"; do
            if [[ ! -f "$scaffold_dir/$expected" ]]; then
                echo "  FAIL: auth-ui did not write $expected in $tname"
                FAIL+=("$tname(auth-ui:$expected)")
                continue 2
            fi
        done

        # …and the item's deps were injected into the scaffold's manifest.
        if ! node -e "
            const p = require('$scaffold_dir/package.json');
            const deps = { ...p.dependencies, ...p.devDependencies };
            process.exit(deps['better-auth'] && deps['@lunora/auth'] ? 0 : 1);
        " 2>/dev/null; then
            echo "  FAIL: auth-ui deps missing from $tname package.json"
            FAIL+=("$tname(auth-ui:deps)")
            continue
        fi

        echo "  ==> auth-ui OK (re-installing for the injected deps)"
        if ! (cd "$scaffold_dir" && pnpm install --no-frozen-lockfile 2>&1) >> "$install_log"; then
            echo "  FAIL: pnpm install after auth-ui failed for $tname (see $install_log)"
            FAIL+=("$tname(auth-ui:install)")
            continue
        fi
    fi

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
