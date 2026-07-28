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
# PREREQUISITE: build production artifacts first.
#
#   pnpm run build:packages:prod
#
# This script packs whatever is sitting in each package's `dist/`, and the plain
# `build` target is a packem *development* build that keeps `react/jsx-dev-runtime`.
# Pack that and the Next template's production prerender dies with
# `TypeError: (0, p.jsxDEV) is not a function` — a failure that says nothing about
# the template, because users install the production build. See
# `scripts/check-dist-production.js`, which guards the same thing at release.
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

# The Next template's `app/providers.tsx` throws when NEXT_PUBLIC_LUNORA_URL is
# unset in a production build — deliberately, so a deployed bundle can never
# point at whatever localhost the developer happened to have. `next build`
# prerenders every route, so that throw aborts the build. Supply the value the
# two-worker split expects; harmless for every other template, which ignores it.
export NEXT_PUBLIC_LUNORA_URL="http://localhost:8787"

# In-place `sed` is not portable: GNU (Linux/CI) takes `-i` with an OPTIONAL
# suffix attached to the flag, BSD (macOS) requires the suffix as a separate
# argument. Resolve the right spelling once — a `sed --version` that succeeds
# means GNU.
if sed --version > /dev/null 2>&1; then
    SED_INPLACE=(sed -i)
else
    SED_INPLACE=(sed -i '')
fi

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRATCH="$(mktemp -d -t lunora-tmpl-XXXXXX)"

# Archive the per-template logs next to the repo before deleting the scratch dir,
# so a CI run can upload them. Without this the trap wins the race and a failed
# matrix leaves nothing to read but the truncated tail this script prints.
LOG_ARCHIVE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/.template-smoke-logs"
archive_logs() {
    if [[ -d "$SCRATCH/results" ]]; then
        rm -rf "$LOG_ARCHIVE"
        mkdir -p "$LOG_ARCHIVE"
        cp -R "$SCRATCH/results/." "$LOG_ARCHIVE/" 2>/dev/null || true
    fi
    rm -rf "$SCRATCH"
}
trap archive_logs EXIT

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
#
# Currently empty: every template builds. It stays as a mechanism because the
# XPASS branch makes it self-cleaning — an entry that starts passing fails the
# run, so a fix can never quietly leave a stale exemption behind. That is how
# the astro entry was retired: bumping @astrojs/cloudflare turned it green and
# the matrix refused to accept the exemption.
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
# Templates whose scaffold cannot typecheck the copied auth-ui payload with the
# tooling it ships. A scaffold's only checker is `typescript` — no `vue-tsc`, no
# `svelte-check`, no `@astrojs/check` — so a port written as SFCs, or a tsconfig
# whose `include` pulls in files `tsc` cannot parse, has no in-scaffold gate.
#
# These are NOT unchecked: `pnpm --filter @lunora/auth-ui run lint:types` runs
# vue-tsc and svelte-check over the same sources in the monorepo. What is missing
# is only the proof that they compile against the meta-framework's own tsconfig.
# Adding the matching checker to those templates' devDependencies would close it.
# ---------------------------------------------------------------------------
typecheck_skip_reason() {
    case "$1" in
        astro) echo "tsconfig includes .astro files; needs @astrojs/check" ;;
        nuxt) echo "Vue SFC payload; needs vue-tsc + a nuxt prepare" ;;
        sveltekit) echo "Svelte SFC payload; needs svelte-check + a svelte-kit sync" ;;
        *) echo "no in-scaffold checker" ;;
    esac
}

TYPECHECK_UNSUPPORTED=("astro" "nuxt" "sveltekit")

is_typecheck_unsupported() {
    local name="$1"
    for s in "${TYPECHECK_UNSUPPORTED[@]+"${TYPECHECK_UNSUPPORTED[@]}"}"; do
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
  vue-demi: true
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
TYPECHECK_SKIPPED=()

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
        -exec "${SED_INPLACE[@]}" 's/{{name}}/'"$tname"'-app/g' {} +

    # Fail loudly if any placeholder survived. This used to be
    # `sed -i '' ... 2>/dev/null || true`, which is BSD-only: GNU sed reads the
    # `''` as the backup suffix and the script as a FILENAME, so on Linux it
    # errored out and changed nothing — and the redirect swallowed the error.
    # The scaffolds then built with a literal `{{name}}` in wrangler.jsonc, which
    # only some templates validate, so the matrix was green on macOS and failed
    # in CI for four templates with an error that pointed at wrangler.
    if grep -rlF '{{name}}' "$scaffold_dir" --exclude-dir=node_modules > /dev/null 2>&1; then
        echo "  FAIL: {{name}} placeholder survived scaffolding in $tname"
        grep -rlF '{{name}}' "$scaffold_dir" --exclude-dir=node_modules | sed "s|$scaffold_dir/|    |"
        FAIL+=("$tname(scaffold:placeholder)")
        continue
    fi

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

    AUTHUI_ADDED="no"

    # -- lunora add auth-ui -------------------------------------------------
    # For every template whose framework the CLI can detect — the auth-ui payload
    # is per-framework, and each of the five ports has to be proven to land and
    # compile inside a real scaffold. The CLI's own tests copy into a bare fixture
    # directory that never builds, so this is the only place Vue/Svelte/Solid/
    # Angular payloads meet their meta-framework's compiler.
    #
    # The expected view file mirrors `detectAuthUiItem` in
    # packages/cli/src/commands/add/features.ts — keep the two in step.
    authui_view="$(node -e "
        const p = require('$scaffold_dir/package.json');
        const d = { ...p.dependencies, ...p.devDependencies };
        const has = (n) => Object.hasOwn(d, n);
        // React Native is not a DOM target: the react payload would not work there.
        if (has('react-native') || has('@lunora/react-native')) process.stdout.write('');
        else if (has('@lunora/react')) process.stdout.write('react/auth-cards.tsx');
        else if (has('@lunora/vue')) process.stdout.write('vue/SignInCard.vue');
        else if (has('@lunora/svelte')) process.stdout.write('svelte/SignInCard.svelte');
        else if (has('@lunora/solid')) process.stdout.write('solid/auth-cards.tsx');
        else if (has('@lunora/angular')) process.stdout.write('angular/auth-cards.ts');
        else if (has('react')) process.stdout.write('react/auth-cards.tsx');
        else if (has('vue')) process.stdout.write('vue/SignInCard.vue');
        else if (has('svelte')) process.stdout.write('svelte/SignInCard.svelte');
        else if (has('solid-js')) process.stdout.write('solid/auth-cards.tsx');
        else if (has('@angular/core')) process.stdout.write('angular/auth-cards.ts');
        else process.stdout.write('');
    " 2>/dev/null || true)"

    if [[ -n "$authui_view" ]]; then
        echo "  ==> lunora add auth-ui (expecting lunora/auth-ui/$authui_view)"
        authui_log="$RESULTS_DIR/${tname}-auth-ui.log"
        # `dist/bin.mjs`, not `dist/index.mjs` — the package's `bin` field. Running
        # the library entry instead just evaluates a barrel of re-exports and exits
        # 0 without parsing argv, so the whole step silently did nothing.
        if ! (cd "$scaffold_dir" && node "$REPO_ROOT/packages/cli/dist/bin.mjs" add auth-ui --yes --from "$REPO_ROOT/registry" 2>&1) > "$authui_log"; then
            echo "  FAIL: lunora add auth-ui failed for $tname (see $authui_log)"
            FAIL+=("$tname(auth-ui)")
            continue
        fi

        # The user-owned copy landed where the item promises…
        for expected in \
            "lunora/auth-ui/core/sign-in.ts" \
            "lunora/auth-ui/$authui_view" \
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

        AUTHUI_ADDED="yes"
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

    # -- typecheck the copied screens ---------------------------------------
    # `pnpm run build` alone proves nothing about the payload: no template imports
    # `lunora/auth-ui/**`, and a bundler only compiles what a build entry reaches,
    # so the copied files are tree-shaken away before a compiler ever sees them.
    # Every template's tsconfig DOES list `lunora/**/*`, so `tsc --noEmit` in the
    # scaffold is what actually compiles them.
    #
    # Runs AFTER the build on purpose: the build is what emits `_generated/` and
    # the framework's own route types, and without those `tsc` drowns in
    # `Cannot find module '#lunora/_generated/server.js'`.
    #
    # Only diagnostics whose path is under `lunora/auth-ui/` fail the run. The
    # templates carry unrelated type errors of their own (a `fontFamily` in the
    # Solid template's `__root.tsx`, route types that need a build that failed) and
    # this gate is not the place to litigate them — it answers one question: does
    # the payload compile under this meta-framework's tsconfig? Unrelated errors
    # are counted and printed so they stay visible.
    if [[ "$AUTHUI_ADDED" == "yes" ]]; then
        if is_typecheck_unsupported "$tname"; then
            echo "  ==> NOTICE: no in-scaffold typecheck for $tname ($(typecheck_skip_reason "$tname"))"
            TYPECHECK_SKIPPED+=("$tname")
        else
            echo "  ==> tsc --noEmit (compiling the copied screens)"
            typecheck_log="$RESULTS_DIR/${tname}-typecheck.log"
            (cd "$scaffold_dir" && pnpm exec tsc --noEmit 2>&1) > "$typecheck_log" || true

            authui_errors="$(grep -c '^lunora/auth-ui/' "$typecheck_log" || true)"
            other_errors="$(grep -c 'error TS' "$typecheck_log" || true)"
            other_errors=$((other_errors - authui_errors))

            if [[ "$authui_errors" -gt 0 ]]; then
                echo "  FAIL: $authui_errors type error(s) in the copied auth-ui screens in $tname (see $typecheck_log)"
                grep '^lunora/auth-ui/' "$typecheck_log" | head -25 | sed 's/^/    /'
                FAIL+=("$tname(auth-ui:typecheck)")
                continue
            fi

            if [[ "$other_errors" -gt 0 ]]; then
                echo "  ==> typecheck OK for lunora/auth-ui/** ($other_errors pre-existing error(s) elsewhere in $tname, not gated here)"
            else
                echo "  ==> typecheck OK"
            fi
        fi
    fi

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
    for f in "${FAIL[@]+"${FAIL[@]}"}"; do [[ "$f" == "${t}(auth-ui:typecheck)" ]] && result="FAIL(typecheck)" && break; done
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

# State what the run did NOT cover, so a green matrix can't be read as more than
# it is. A template listed here installed and built, but no compiler in the
# scaffold ever looked at the auth-ui files it copied in.
if [[ ${#TYPECHECK_SKIPPED[@]} -gt 0 ]]; then
    echo ""
    echo "  NOT typechecked in-scaffold (payload compiled only by the monorepo's lint:types):"
    for t in "${TYPECHECK_SKIPPED[@]}"; do
        printf "    %-20s  %s\n" "$t" "$(typecheck_skip_reason "$t")"
    done
fi

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
