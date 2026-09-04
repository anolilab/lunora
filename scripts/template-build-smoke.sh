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
#   5. Runs `pnpm run build` — which is what proves the copied auth screens
#      actually compile in a real app. A template with no build script instead
#      runs `pnpm run codegen` first, so there is something to check.
#   6. Typechecks the scaffold with the checker that can read its payload,
#      failing on ANY diagnostic, then proves the checker actually READ that
#      payload (the coverage floor — see set_typecheck).
#   7. Runs the template's own deploy path as a credential-free dry run and gates
#      on its exit code, the binding table it printed and the bundle it emitted
#      (see run_deploy_dryrun). Building is not shipping: three release-blocking
#      defects lived in that gap simultaneously.
#   8. Records PASS / XFAIL(expected failure) / XPASS(unexpected pass) / FAIL.
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
# Scaffolding note: templates are obtained by direct `cp -R` from the templates/
# root — offline-deterministic, identical to what giget would produce. This
# avoids the isTemplate guard in init/handler.ts that falls back to "vite" for
# unsupported names.
#
# What this does NOT cover:
#   - The remote giget fetch path (needs network + a published template ref).
#   - Starting the Vite+workerd dev server (long-running, needs a real CF account).
#   - A real publish. The deploy leg is `--dry-run`, so it proves the worker
#     bundles, binds and parses — not that Cloudflare accepts it.
#   - Running codegen on the *buildable* templates' scaffolds — their bundler
#     runs it via the Vite plugin / astro integration. Only the no-build path
#     invokes `lunora codegen` directly here; clean-machine-smoke.sh covers it
#     against a tarball-installed CLI.

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

# Enforce the production-build prerequisite instead of documenting it. Packing a
# development `dist/` fails a long way downstream — `next build` prerenders and
# dies with `(0, p.jsxDEV) is not a function`, which reads as a Next problem and
# is not. Easy to hit by accident: any `vis run build` (the DEV target) run while
# debugging silently re-poisons `dist/` after a correct `build:packages:prod`.
echo "==> Verifying dist/ holds production artifacts"
if ! node "$REPO_ROOT/scripts/check-dist-production.js" > "$RESULTS_DIR/dist-check.log" 2>&1; then
    echo "ERROR: dist/ carries development-build markers — run 'pnpm run build:packages:prod' first." >&2
    tail -20 "$RESULTS_DIR/dist-check.log" >&2
    exit 1
fi

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
# (This used to record react-router and solid-start as removed for supporting only
# Vite <=7. Both are back: `templates/react-router` and
# `templates/tanstack-start-solid` exist, pin `vite ^8.0.16`, and pass the matrix.
# The note is kept as history because the removal is in the git log and a reader
# finding no trace of it is worse than a dated sentence.)
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
# `pnpm run build` step.
#
# NOTHING ELSE COVERS IT. This comment used to claim a CLI init smoke test
# validated it separately; there is no such test — `packages/cli/__tests__`
# never mentions expo, `scripts/clean-machine-smoke.sh` scaffolds only
# tanstack-start-react, and that script is in no workflow either. The template
# declares `lint:types` (`lunora codegen && tsc --noEmit`) and nothing invokes
# it, so a breaking `@lunora/*` change reaches templates/expo with every gate
# green. Closing this means either an expo leg here (its `lint:types` is exactly
# the no-build path below, once the native toolchain is affordable in CI) or a
# workflow that runs `test:clean-machine` against it.
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
# Per-template in-scaffold typechecker.
#
# `tsc` cannot read every payload: the Vue and Svelte ports are single-file
# components, and Astro needs the `.astro`-aware language server. So each
# template names the checker that CAN read its payload, together with the two
# patterns that recognise a diagnostic line in that checker's output format —
# because those formats differ, and a gate that matches nothing is worse than
# no gate at all.
#
#   TYPECHECK_DEP   — devDependency the scaffold needs for the checker (empty
#                     when the template already ships the binary)
#   TYPECHECK_PREP  — argv run first, to generate the framework's own tsconfig
#                     and ambient types (empty when there is nothing to generate)
#   TYPECHECK_CMD   — the checker itself
#   AUTHUI_RE       — ERE matching ONE diagnostic for a file under lunora/auth-ui/
#   ERROR_RE        — ERE matching ONE diagnostic for ANY file
#   FILE_RE         — ERE matching ONE diagnostic that NAMES A FILE, i.e. that
#                     proves the checker got as far as reading source. Defaults to
#                     TypeScript's `path(line,col): error TSxxxx`; overridden for the
#                     checkers with a different format. See the vacuous-pass guard
#                     below for why this is not the same question as ERROR_RE.
#   COVERAGE_MODE   — how this checker PROVES it read the payload, `listfiles` or
#                     `canary`. Either way the floor demands evidence for BOTH
#                     `core/sign-in.ts` and the framework view. See the coverage
#                     floor below.
#
# The checker is injected into the scaffold at smoke time (see
# inject_typecheck_dep, same idea as inject_peer_deps) rather than added to
# `templates/*/package.json`: a real user should not be made to install a
# typechecker they never asked for just so this matrix can run one.
# ---------------------------------------------------------------------------
set_typecheck() {
    TYPECHECK_DEP=""
    TYPECHECK_PREP=()
    # TypeScript's own format, shared by `tsc` and `vue-tsc`.
    FILE_RE='\([0-9]+,[0-9]+\): error TS'
    # `tsc`/`vue-tsc` can just be asked what they read.
    COVERAGE_MODE="listfiles"

    case "$1" in
        astro)
            # `astro check` is @astrojs/language-server driven from the project's
            # tsconfig, so it reads `.astro` AND the `.tsx` auth-ui payload that
            # tsconfig's `include` lists. It prints via TypeScript's
            # `formatDiagnosticsWithColorAndContext` — which always colours, hence
            # the ANSI strip at the call site — and rewrites `TS1234` to `ts(1234)`.
            TYPECHECK_DEP="@astrojs/check@^0.9.10"
            TYPECHECK_CMD=(pnpm exec astro check)
            AUTHUI_RE='^lunora/auth-ui/.*error ts\('
            ERROR_RE='error ts\('
            FILE_RE='[0-9]+:[0-9]+ - error ts\('
            # No `--listFiles` equivalent: the language server owns the program and
            # never publishes its file set.
            COVERAGE_MODE="canary"
            ;;
        nuxt)
            # `nuxt prepare` writes `.nuxt/tsconfig.json` — the config the
            # template's root tsconfig extends. Without it there is no `include`,
            # so nothing to check.
            TYPECHECK_DEP="vue-tsc@^3.3.8"
            TYPECHECK_PREP=(pnpm exec nuxt prepare)
            TYPECHECK_CMD=(pnpm exec vue-tsc --noEmit)
            AUTHUI_RE='^lunora/auth-ui/'
            ERROR_RE='error TS'
            ;;
        sveltekit)
            # `--tsconfig`: without it svelte-check looks at `.svelte` files ONLY
            # and the payload's `core/*.ts` would go unchecked. `--output machine`:
            # the human formats put the path and the `Error:` on separate lines,
            # which no single-line pattern can gate on.
            #
            # There is no way to scope this run: svelte-check reports every file in
            # the tsconfig's PROGRAM (`getSourceFiles()`, skipping only lib files and
            # `node_modules/**.js`), and its `--ignore` is rejected unless
            # `--no-tsconfig` is also passed — which drops `core/*.ts`, the thing the
            # `--tsconfig` above is here for. So the emitted `.svelte-kit/output/**`
            # bundle is kept out of the DIAGNOSTICS instead, by `checkJs: false` in
            # `templates/sveltekit/tsconfig.json`; see the comment there.
            TYPECHECK_DEP="svelte-check@^4.7.3"
            TYPECHECK_PREP=(pnpm exec svelte-kit sync)
            TYPECHECK_CMD=(pnpm exec svelte-check --tsconfig ./tsconfig.json --output machine --threshold error)
            AUTHUI_RE='^[0-9]+ ERROR "lunora/auth-ui/'
            ERROR_RE='^[0-9]+ ERROR "'
            # svelte-check's machine format carries the path in every diagnostic,
            # so "is a diagnostic" and "names a file" are the same question here.
            FILE_RE='^[0-9]+ ERROR "'
            # No `--listFiles` equivalent: the machine format reports a FILES count
            # but never which files, and a count cannot say whether the payload
            # was among them.
            COVERAGE_MODE="canary"
            ;;
        react-router)
            # `react-router typegen` writes `.react-router/types/**` — the route
            # module types every route imports as `./+types/<route>`, resolved through
            # the tsconfig's `rootDirs`. This is what the template's own `typecheck`
            # script runs and what React Router documents for CI; without it every
            # route fails on `Cannot find module './+types/root'`.
            TYPECHECK_PREP=(pnpm exec react-router typegen)
            TYPECHECK_CMD=(pnpm exec tsc --noEmit)
            AUTHUI_RE='^lunora/auth-ui/'
            ERROR_RE='error TS'
            ;;
        *)
            TYPECHECK_CMD=(pnpm exec tsc --noEmit)
            AUTHUI_RE='^lunora/auth-ui/'
            ERROR_RE='error TS'
            ;;
    esac
}

# ---------------------------------------------------------------------------
# Per-template credential-free deploy dry run.
#
# `pnpm run build` says a scaffold COMPILES. It says nothing about whether the
# thing it compiled can be deployed, and that gap is where three separate
# release-blocking defects lived at once, invisible to every gate in this repo:
#
#   - templates/analog pointed `main` at Nitro's output, which exports only
#     `default` — `wrangler deploy` rejected every fresh scaffold with "Durable
#     Objects … not exported in your entrypoint file: ShardDO".
#   - templates/astro shipped its composed entry as `src/worker.ts`, which
#     `lunora deploy` passes to wrangler POSITIONALLY; combined with the
#     @astrojs/cloudflare redirect's `no_bundle: true` that uploaded the raw,
#     untranspiled TypeScript source as the worker — a 1.4 KiB "successful"
#     deploy.
#   - templates/{nuxt,analog} bound no `assets` directory, so Nitro's Cloudflare
#     runtime (which serves client assets ONLY via `env.ASSETS`) 404'd every
#     `/_nuxt/*` request while the SSR HTML rendered fine.
#
# Note what those three need: an exit code catches the first, the emitted BUNDLE
# catches the second, and the UPLOADED ASSET COUNT catches the third. A dry run
# that only checked its exit status would have passed astro and nuxt. All four
# assertions below are load-bearing; see run_deploy_dryrun.
#
# Everything here is offline and unauthenticated: `wrangler deploy --dry-run`
# validates, bundles and prints the binding table without contacting the API,
# and `lunora build` is exactly `wrangler deploy --dry-run --outdir` behind the
# CLI's own pre-deploy gates (codegen, wrangler validation, schema drift).
#
#   DEPLOY_DRYRUN_CMDS — argv arrays to run in the scaffold, `|`-separated per
#                        command so several can share one variable. The bundle
#                        output directory is passed in.
#
# Each command MIRRORS what that template's own `deploy` script runs — a gate
# against a deploy path no user takes proves nothing about the one they do.
# ---------------------------------------------------------------------------
set_deploy_dryrun() {
    local out="$2"

    case "$1" in
        analog | nuxt)
            # `deploy` is `<build> && wrangler deploy` — Nitro owns the adapter, so
            # there is no `lunora deploy` in the path to mirror.
            DEPLOY_DRYRUN_CMDS=("pnpm|exec|wrangler|deploy|--dry-run|--outdir|$out")
            ;;
        next)
            # Two workers, two configs. The ROOT `wrangler.jsonc` is the Lunora
            # worker (`deploy:lunora`); the Next SSR worker is built by OpenNext and
            # deployed from `wrangler.opennext.jsonc` (`deploy:next`).
            #
            # `wrangler deploy --dry-run --config …` stands in for
            # `opennextjs-cloudflare deploy`, which has no dry run and would reach
            # the API to populate the incremental cache. The OpenNext BUILD is real:
            # it is what produces `.open-next/worker.js`, and `pnpm run build`
            # (`next build`) does not.
            DEPLOY_DRYRUN_CMDS=(
                "pnpm|exec|wrangler|deploy|--dry-run|--outdir|$out/lunora"
                "pnpm|exec|opennextjs-cloudflare|build|--config|wrangler.opennext.jsonc"
                "pnpm|exec|wrangler|deploy|--dry-run|--config|wrangler.opennext.jsonc|--outdir|$out/next"
            )
            ;;
        *)
            # `deploy` is `<build> && lunora deploy`. `lunora build` is that command
            # with `--dry-run --outdir`, so it exercises the CLI's composed-entry
            # resolution, its preflights and the wrangler validator — the parts a
            # bare `wrangler deploy --dry-run` would skip.
            DEPLOY_DRYRUN_CMDS=("node|$REPO_ROOT/packages/cli/dist/bin.mjs|build|--out-dir|$out")
            ;;
    esac
}

# ---------------------------------------------------------------------------
# Run this template's deploy dry runs and gate on what they produced.
#
# `expect_assets` is derived, not hand-maintained: a template with a `build`
# script produces a client bundle, and a client bundle that no worker binds as
# assets is a 404 per file.
#
# Prints its own FAIL lines and returns non-zero; the caller records the stage.
# ---------------------------------------------------------------------------
run_deploy_dryrun() {
    local tname="$1"
    local scaffold_dir="$2"
    local out="$3"
    local log="$4"
    local expect_assets="$5"

    : > "$log"
    rm -rf "$out"

    # `lunora add auth-ui` pulled in the `auth` registry item, which writes a D1
    # binding carrying a `<replace-with-d1-create-id>` placeholder — and
    # `lunora build` hard-blocks on it, correctly: shipping that placeholder is a
    # broken deploy. Resolving it for real means `wrangler d1 create`, which needs
    # a Cloudflare account. So stand a syntactically valid id in, the same way this
    # matrix already substitutes tarball overrides and a typechecker into the
    # scaffold. The placeholder gate has its own coverage in
    # `packages/cli/__tests__/commands/deploy.test.ts`; what is measured here is
    # whether the WORKER deploys.
    local cfg
    while IFS= read -r cfg; do
        "${SED_INPLACE[@]}" 's/<replace-with-d1-create-id>/00000000-0000-4000-8000-000000000000/g' "$cfg"
    done < <(find "$scaffold_dir" -maxdepth 1 -type f -name 'wrangler*.json*')

    set_deploy_dryrun "$tname" "$out"

    local spec
    for spec in "${DEPLOY_DRYRUN_CMDS[@]}"; do
        local -a argv=()
        # `read -r -a`: `read -A` is zsh, and this script is bash.
        IFS='|' read -r -a argv <<< "$spec"

        echo "  ==> deploy dry run: ${argv[*]}"

        local status=0
        { (cd "$scaffold_dir" && "${argv[@]}" 2>&1) \
            | sed -E "s/$(printf '\033')\[[0-9;]*m//g" >> "$log"; } || status=$?

        if [[ "$status" -ne 0 ]]; then
            echo "  FAIL: \`${argv[*]}\` in $tname exited $status (see $log)"
            echo "        A scaffold that builds but cannot be deployed is broken for every user of this template."
            tail -25 "$log" | sed 's/^/    /'
            return 1
        fi
    done

    # 1. The Durable Object binding must survive into the deployed worker. Wrangler
    #    prints the binding table it is about to publish; a table without the DO
    #    means the deploy path resolved a config the template does not ship.
    if ! grep -qF "env.SHARD (ShardDO)" "$log"; then
        echo "  FAIL: no \`env.SHARD (ShardDO)\` binding in $tname's deploy dry run (see $log)"
        echo "        Every template's realtime plane needs the SHARD Durable Object; wrangler printed a"
        echo "        binding table without it, so the deploy path resolved a config that does not bind it."
        return 1
    fi

    # 2. A client build the deploy never uploads renders SSR HTML and 404s every
    #    script and stylesheet it references. Wrangler cannot know that is wrong,
    #    so the dry run exits 0 — this is the only place it is caught.
    #
    #    The signal is wrangler's own `Read N files from the assets directory …`,
    #    NOT an `env.ASSETS` line: a worker that binds the asset fetcher and one
    #    whose assets are served by the platform's router ahead of it are both
    #    correct, and the class-A templates take the second shape (their adapter's
    #    redirect config sets `assets.directory` with no `binding`). Requiring the
    #    binding failed react-router, whose assets were being uploaded the whole
    #    time. `[1-9]` because "Read 0 files" is a wrong directory, which is the
    #    same 404 with a config that looks right.
    if [[ "$expect_assets" == "yes" ]] && ! grep -qE "Read [1-9][0-9]* files? from the assets directory" "$log"; then
        echo "  FAIL: $tname's deploy dry run uploaded no client assets (see $log)"
        echo "        This template has a \`build\` script, so it emits a client bundle — and a client bundle the"
        echo "        deploy never uploads 404s file by file against a page that renders fine. wrangler prints"
        echo "        \`Read N files from the assets directory …\` when it has one; it printed none, or none with"
        echo "        any files in it."
        echo "        Add \`assets: { directory: … }\` to the wrangler config (with \`binding: \"ASSETS\"\` if the"
        echo "        worker serves them itself, as Nitro's Cloudflare runtime does), or have the framework"
        echo "        adapter inject one."
        return 1
    fi

    # 3. The emitted bundle must be JavaScript. wrangler will happily "deploy" a
    #    raw `.ts` entry when the config it resolved carries `no_bundle: true` (an
    #    adapter redirect does) and something overrides `main` with a source path —
    #    exit 0, binding table printed, and a worker that is a syntax error in
    #    workerd. Nothing else here can tell that apart from a real deploy.
    local ts_in_bundle
    ts_in_bundle="$(find "$out" -type f \( -name '*.ts' -o -name '*.tsx' \) 2> /dev/null | head -5)"

    if [[ -n "$ts_in_bundle" ]]; then
        echo "  FAIL: $tname's deploy dry run emitted TypeScript SOURCE as the worker bundle:"
        echo "$ts_in_bundle" | sed "s|$out/|    |"
        echo "        The entry was passed through untranspiled — the deploy would succeed and the worker"
        echo "        would fail to parse in workerd. Check what \`main\`/the positional entry resolved to."
        return 1
    fi

    echo "  ==> deploy dry run OK ($(grep -c 'env\.' "$log" || true) binding line(s) across ${#DEPLOY_DRYRUN_CMDS[@]} command(s))"

    return 0
}

# ---------------------------------------------------------------------------
# Helper: add the scaffold's typechecker as a local devDep.
# ---------------------------------------------------------------------------
inject_typecheck_dep() {
    local scaffold_dir="$1"
    local spec="$2"

    node -e "
const fs = require('fs');
const spec = process.argv[1];
const at = spec.lastIndexOf('@');
const name = spec.slice(0, at);
const range = spec.slice(at + 1);
const file = '$scaffold_dir/package.json';
const pkg = JSON.parse(fs.readFileSync(file, 'utf8'));

pkg.devDependencies ??= {};

// Never shadow a spec the template declares itself — that spec is part of what
// this matrix is testing.
if (!pkg.dependencies?.[name] && !pkg.devDependencies[name]) {
    pkg.devDependencies[name] = range;
}

fs.writeFileSync(file, JSON.stringify(pkg, null, 4) + '\n');
" "$spec"
}

# ---------------------------------------------------------------------------
# A nonzero typecheck exit is only interesting when NOTHING was reported: every
# checker here exits nonzero whenever it finds type errors, and those are gated
# (and printed) by the caller. An exit with no diagnostic at all means the
# checker never got as far as reading source, so a green result would prove
# nothing. Takes the per-template pattern — `error TS` is only tsc's shape.
# ---------------------------------------------------------------------------
typecheck_never_ran() {
    local status="$1"
    local log="$2"
    local error_re="$3"

    [[ "$status" -ne 0 ]] && ! grep -qE "$error_re" "$log"
}

# ---------------------------------------------------------------------------
# Helper: plant a deliberate type error in a payload file (the coverage canary).
# ---------------------------------------------------------------------------
# Used by the `canary` COVERAGE_MODE below. The insertion point depends on the
# file's shape:
#
#   .ts/.tsx — append. Top level, nothing follows it.
#   .svelte/.vue — insert immediately before the LAST `</script>`, i.e. at the
#     end of the component's script block. Matching the last closing tag is what
#     makes this deterministic: an SFC may carry a second `<script>` (Svelte's
#     `module` context, Vue's non-`setup` block) and both toolchains require the
#     instance/setup block to be the final one, so the last `</script>` always
#     closes a TS script block. Appending after the tag instead would land the
#     const in the template markup, where it is not TypeScript at all.
#
# Exits non-zero rather than writing a file it could not place the canary in —
# a silently-unplanted canary would make the coverage gate below vacuous, which
# is the exact failure it exists to catch.
plant_canary() {
    node -e '
const fs = require("fs");
const file = process.argv[1];
const canary = "\n// coverage canary — injected by scripts/template-build-smoke.sh, restored below.\nconst __lunoraCoverageCanary: number = \"not a number\";\n";
const source = fs.readFileSync(file, "utf8");

if (/\.(svelte|vue)$/.test(file)) {
    const at = source.lastIndexOf("</script>");

    if (at === -1) {
        console.error(`no </script> in ${file} — cannot plant a canary inside its script block`);
        process.exit(1);
    }

    fs.writeFileSync(file, source.slice(0, at) + canary + source.slice(at));
} else {
    fs.writeFileSync(file, source + canary);
}
' "$1"
}

# ---------------------------------------------------------------------------
# Helper: AUTHUI_RE narrowed to ONE payload file.
# ---------------------------------------------------------------------------
# Every AUTHUI_RE contains the literal `lunora/auth-ui/` (that is what it gates
# on); splicing the payload-relative path in right after it yields a pattern
# that matches a diagnostic for THAT file only, in whichever format the current
# checker prints. Keeps the per-file coverage gate free of a second set of
# per-template patterns that could drift from the first.
authui_file_re() {
    local literal='lunora/auth-ui/'
    printf '%s' "${AUTHUI_RE/"$literal"/$literal$1}"
}

# ---------------------------------------------------------------------------
# Discover templates (dynamic, so adding a new dir is automatically included).
# ---------------------------------------------------------------------------
TEMPLATES=()
SKIPPED=()
for t_dir in "$REPO_ROOT/templates"/*/; do
    tname="$(basename "$t_dir")"
    if is_skipped "$tname"; then
        echo "==> Skipping $tname (not part of the worker-toolchain smoke matrix)"
        SKIPPED+=("$tname")
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

# Every `@lunora/*` name that a workspace package declares as a REQUIRED peer, so
# the scaffold can satisfy it from a tarball as well.
#
# `overrides` alone is not enough: pnpm auto-installs a MISSING peer as a root
# dependency of the project and resolves it FROM THE REGISTRY, ignoring overrides
# entirely. `@lunora/vite` → `@lunora/config` → `@lunora/seed`, whose peers are
# `@lunora/server` and `@lunora/values`, so every vite-based template quietly
# fetched two base packages from npm at whatever version the graph asked for.
#
# Peers marked optional in the declaring package's `peerDependenciesMeta` are
# EXCLUDED: pnpm does not auto-install a missing optional peer, so it is not a
# leak vector, and injecting it would hand every scaffold a package a real user's
# install would leave unsatisfied — the opposite of what this matrix is for. The
# check is per-declaration, not per-name: `@lunora/server` is optional for
# `@lunora/replica` and `@lunora/cloudflare-access` yet required by `@lunora/seed`,
# and one required declaration is enough to make it auto-installable.
#
# That works right up until a release commit bumps a version whose publish has not
# landed — which is exactly how this matrix broke on `@lunora/values@1.0.0-alpha.24`,
# a version that was version-bumped in the repo and never published (npm holds
# alpha.23 and alpha.25, with nothing in between). The two templates without
# `@lunora/vite` passed the same run, because they have no `seed` edge and so no
# peer to auto-install.
PEER_NAMES="$(node -e "
const fs = require('fs');
const path = require('path');
const rows = fs.readFileSync('$PACK_MANIFEST', 'utf8').trim().split('\n').filter(Boolean);
const packed = new Set(rows.map((row) => row.split('\t')[0]));
const peers = new Set();

for (const dir of fs.readdirSync('$REPO_ROOT/packages')) {
    const manifest = path.join('$REPO_ROOT/packages', dir, 'package.json');

    if (!fs.existsSync(manifest)) continue;

    const pkg = JSON.parse(fs.readFileSync(manifest, 'utf8'));

    for (const name of Object.keys(pkg.peerDependencies ?? {})) {
        if (pkg.peerDependenciesMeta?.[name]?.optional) continue;
        if (packed.has(name)) peers.add(name);
    }
}

process.stdout.write([...peers].sort().join(' '));
")"

echo "==> Peer base packages to satisfy locally: ${PEER_NAMES:-<none>}"

# ---------------------------------------------------------------------------
# Helper: add the peer base packages to a scaffold as local-tarball devDeps.
# ---------------------------------------------------------------------------
inject_peer_deps() {
    local scaffold_dir="$1"

    node -e "
const fs = require('fs');
const rows = fs.readFileSync('$PACK_MANIFEST', 'utf8').trim().split('\n').filter(Boolean);
const tarball = new Map(rows.map((row) => row.split('\t')));
const names = '$PEER_NAMES'.split(' ').filter(Boolean);
const file = '$scaffold_dir/package.json';
const pkg = JSON.parse(fs.readFileSync(file, 'utf8'));

pkg.devDependencies ??= {};

for (const name of names) {
    // Never shadow a dependency the template declares itself — that spec is part
    // of what this matrix is testing.
    if (pkg.dependencies?.[name] || pkg.devDependencies[name]) continue;

    pkg.devDependencies[name] = 'file:' + tarball.get(name);
}

fs.writeFileSync(file, JSON.stringify(pkg, null, 4) + '\n');
"
}

# ---------------------------------------------------------------------------
# Helper: assert no @lunora/* package came from the npm registry.
# ---------------------------------------------------------------------------
# The whole point of the tarball overrides is that this matrix tests the code in
# THIS checkout. A registry resolution silently tests a published version instead,
# and only fails on the day that version does not exist — so it is checked rather
# than assumed.
assert_no_registry_lunora() {
    local scaffold_dir="$1"
    local lockfile="$scaffold_dir/pnpm-lock.yaml"

    [[ -f "$lockfile" ]] || return 0

    local leaked
    # `tr -d` rather than a `?` quantifier in sed: BSD's basic regex has none, so
    # the quote survived and the report named `'@lunora/x` instead of `@lunora/x`.
    # The `(...)` suffix pnpm appends to a peer-resolved variant is excluded too, so
    # one package is reported once rather than twice.
    leaked="$(grep -oE "^  '?(@lunora/[a-z0-9-]+|lunorash)@[0-9][^'(:]*" "$lockfile" | tr -d " '" | sort -u)"

    if [[ -n "$leaked" ]]; then
        echo "  FAIL: these base packages resolved from the npm REGISTRY, not this checkout:"
        echo "$leaked" | sed 's/^/    /'
        return 1
    fi

    return 0
}

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
# Templates whose deploy dry run actually ran. Every FAIL path above it
# `continue`s, so a template missing from this list never reached the gate — and
# a summary that did not say so would read as deploy coverage it does not have.
DEPLOY_CHECKED=()
# Templates whose auth-ui view the detector actually resolved. Everything the
# matrix is really for hangs off a non-empty `authui_view`, so if that comes back
# empty for every template the run proves nothing and has to say so.
AUTHUI_RESOLVED=()

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
    inject_peer_deps "$scaffold_dir"

    # Resolve the checker for this template and add it to the manifest BEFORE the
    # install, so it is present without a third install pass.
    set_typecheck "$tname"
    if [[ -n "$TYPECHECK_DEP" ]]; then
        echo "  ==> injecting typechecker $TYPECHECK_DEP"
        inject_typecheck_dep "$scaffold_dir" "$TYPECHECK_DEP"
    fi

    # -- pnpm install -------------------------------------------------------
    echo "  ==> pnpm install"
    install_log="$RESULTS_DIR/${tname}-install.log"
    if ! (cd "$scaffold_dir" && pnpm install --no-frozen-lockfile 2>&1) > "$install_log"; then
        echo "  FAIL: pnpm install failed for $tname (see $install_log)"
        tail -20 "$install_log" | sed 's/^/    /'
        FAIL+=("$tname(install)")
        continue
    fi

    # A registry resolution means this template was silently tested against a
    # PUBLISHED base package rather than the one in this checkout.
    if ! assert_no_registry_lunora "$scaffold_dir"; then
        FAIL+=("$tname(registry-leak)")
        continue
    fi

    echo "  ==> install OK (no base package came from the registry)"

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
    authui_detect_status=0
    authui_view="$(node -e "
        const p = require('$scaffold_dir/package.json');
        const d = { ...p.dependencies, ...p.devDependencies };
        const has = (n) => Object.hasOwn(d, n);
        // Mirrors \`minimumMajor\`: the lowest major the range admits, not its
        // first digit — \`>1\` floors at 2 and \`2 || 1\` floors at 1.
        // Resolved, not path-joined: \`packages/cli/node_modules/semver\` is a pnpm
        // layout artifact, and a hoist change moves it without warning. The
        // repo root is the fallback for a hoisted install.
        const { minVersion, validRange } = require(require.resolve('semver', { paths: ['$REPO_ROOT/packages/cli', '$REPO_ROOT'] }));
        const major = (r) => (r && validRange(r) !== null ? (minVersion(r)?.major ?? 0) : 0);
        // React Native is not a DOM target: the react payload would not work there.
        // \`expo\` is in the list because \`isReactNativeProject\` has it — an Expo app
        // depends on \`react\` but not always on \`react-native\` directly, so without it
        // this mirror resolves react/auth-cards.tsx where the CLI resolves nothing.
        if (has('react-native') || has('@lunora/react-native') || has('expo')) process.stdout.write('');
        // Solid 2 gets its own payload. Checked before the framework matches,
        // exactly as detectAuthUiItem does, because a Solid 2 project also has
        // solid-js and @lunora/solid and would otherwise take the 1.x views.
        else if (has('@solidjs/web') || major(d['solid-js']) >= 2) process.stdout.write('solid-v2/auth-cards.tsx');
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
    ")" || authui_detect_status=$?

    # NOT `|| true`. This one substitution decides whether the strongest half of
    # the matrix runs at all: an empty result leaves AUTHUI_ADDED="no", which skips
    # `lunora add auth-ui`, every file-landed assertion, the dep-injection check,
    # the per-template typechecker, the typecheck:never-ran guard, the FILE_RE
    # vacuity guard and the planted-error canary. Swallowing the exit status made a
    # resolution failure indistinguishable from "this template has no framework".
    # A template that legitimately has no framework is caught downstream instead:
    # see the `typecheck:skipped` guard on the build path.
    if [[ ${authui_detect_status:-0} -ne 0 ]]; then
        echo "  FAIL: could not resolve the expected auth-ui view for $tname (node exited ${authui_detect_status})"
        echo "        Everything from \`lunora add auth-ui\` onwards would have been skipped, and $tname would have recorded PASS on its build alone."
        FAIL+=("$tname(auth-ui:detect)")
        continue
    fi

    if [[ -n "$authui_view" ]]; then
        AUTHUI_RESOLVED+=("$tname")
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
        # A template with no bundler had nothing compiled at all: scaffold +
        # install was the whole gate, so any type error it ships — including one
        # introduced by a breaking change in `@lunora/*` — passed silently.
        # Run its own `codegen` script (every source file imports
        # `#lunora/_generated/*`, which only exists afterwards), then typecheck.
        #
        # It runs the same per-template checker the auth-ui gate uses — a
        # build-less template falls to the `tsc --noEmit` default, but routing it
        # through `set_typecheck` means a future one that needs a prep step or a
        # different diagnostic format is already handled.
        echo "  ==> NOTICE: no build script in $tname — codegen + ${TYPECHECK_CMD[*]} instead"
        SKIP_BUILD+=("$tname")

        codegen_log="$RESULTS_DIR/${tname}-codegen.log"
        if ! (cd "$scaffold_dir" && pnpm run codegen 2>&1) > "$codegen_log"; then
            echo "  FAIL: codegen failed for $tname (see $codegen_log)"
            tail -20 "$codegen_log" | sed 's/^/    /'
            FAIL+=("$tname(codegen)")
            continue
        fi

        typecheck_log="$RESULTS_DIR/${tname}-typecheck.log"
        : > "$typecheck_log"

        if [[ ${#TYPECHECK_PREP[@]} -gt 0 ]]; then
            (cd "$scaffold_dir" && "${TYPECHECK_PREP[@]}" 2>&1) >> "$typecheck_log" || true
        fi

        typecheck_status=0
        { (cd "$scaffold_dir" && "${TYPECHECK_CMD[@]}" 2>&1) \
            | sed -E "s/$(printf '\033')\[[0-9;]*m//g" >> "$typecheck_log"; } || typecheck_status=$?

        if typecheck_never_ran "$typecheck_status" "$typecheck_log" "$ERROR_RE"; then
            echo "  FAIL: ${TYPECHECK_CMD[*]} in $tname exited $typecheck_status without reporting a diagnostic (see $typecheck_log)"
            echo "        A checker that fails without a diagnostic never read the payload, so this run proves nothing."
            tail -20 "$typecheck_log" | sed 's/^/    /'
            FAIL+=("$tname(typecheck:never-ran)")
            continue
        fi

        ts_errors="$(grep -cE "$ERROR_RE" "$typecheck_log" || true)"

        # Same vacuous-pass guard the build path applies further down, for the same
        # reason: a checker that reported diagnostics naming no FILE aborted during
        # CONFIG resolution and compiled zero files, which the error count cannot
        # tell apart from real type errors. This path had the count and not the
        # guard, and it is the ONLY compilation a build-less template gets.
        if [[ "$ts_errors" -gt 0 ]] && ! grep -qE "$FILE_RE" "$typecheck_log"; then
            echo "  FAIL: typecheck in $tname aborted before reading any file — $ts_errors diagnostic(s), none naming a file (see $typecheck_log)"
            echo "        A file-less diagnostic means the CHECKER is broken (bad tsconfig 'types'/'include',"
            echo "        missing prep step), so this run proves nothing about what it was meant to compile."
            grep -E "$ERROR_RE" "$typecheck_log" | head -10 | sed 's/^/    /'
            FAIL+=("$tname(typecheck:vacuous)")
            continue
        fi

        if [[ "$ts_errors" -gt 0 ]]; then
            echo "  FAIL: $ts_errors type error(s) in $tname (see $typecheck_log)"
            grep -E "$ERROR_RE" "$typecheck_log" | head -25 | sed 's/^/    /'
            FAIL+=("$tname(typecheck)")
            continue
        fi

        echo "  ==> codegen + typecheck OK"

        # No `build` script means no client bundle, so no assets binding is
        # expected — but the worker still has to deploy.
        if ! run_deploy_dryrun "$tname" "$scaffold_dir" "$SCRATCH/${tname}-bundle" "$RESULTS_DIR/${tname}-deploy.log" "no"; then
            FAIL+=("$tname(deploy)")
            continue
        fi

        DEPLOY_CHECKED+=("$tname")
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
    # EVERY diagnostic fails the run, not just ones under `lunora/auth-ui/`. This
    # used to gate the payload only and merely count the templates' own errors,
    # on the reasoning that they were somebody else's problem — which let nine of
    # them accumulate, two of which were real defects (a `LunoraProvider url=`
    # prop that does not exist, so the provider mounted without a client). They
    # are all fixed now, so the cheapest way to keep them fixed is to stop
    # distinguishing.
    #
    # Which checker runs, and what a diagnostic line looks like, is per-template —
    # see set_typecheck.
    if [[ "$AUTHUI_ADDED" == "yes" ]]; then
        typecheck_log="$RESULTS_DIR/${tname}-typecheck.log"
        coverage_log="$RESULTS_DIR/${tname}-coverage.log"
        : > "$typecheck_log"
        : > "$coverage_log"

        if [[ ${#TYPECHECK_PREP[@]} -gt 0 ]]; then
            echo "  ==> ${TYPECHECK_PREP[*]} (generating the framework's tsconfig)"
            (cd "$scaffold_dir" && "${TYPECHECK_PREP[@]}" 2>&1) >> "$typecheck_log" || true
        fi

        # `--listFiles` makes the checker enumerate every file in the program, which
        # is the coverage floor's evidence for the tsc-family checkers. It costs
        # nothing — same pass, extra stdout — so it rides along with the real gate
        # rather than paying for a second compile.
        if [[ "$COVERAGE_MODE" == "listfiles" ]]; then
            TYPECHECK_CMD+=(--listFiles)
        fi

        echo "  ==> ${TYPECHECK_CMD[*]} (compiling the copied screens)"

        # Strip ANSI: `astro check` prints through TypeScript's colour formatter
        # unconditionally, so the escape codes land BEFORE the path and defeat an
        # anchored match. A literal ESC via printf — BSD sed has no `\x1b`.
        typecheck_started=$SECONDS
        typecheck_status=0
        { (cd "$scaffold_dir" && "${TYPECHECK_CMD[@]}" 2>&1) \
            | sed -E "s/$(printf '\033')\[[0-9;]*m//g" >> "$typecheck_log"; } || typecheck_status=$?
        typecheck_elapsed=$((SECONDS - typecheck_started))

        if typecheck_never_ran "$typecheck_status" "$typecheck_log" "$ERROR_RE"; then
            echo "  FAIL: ${TYPECHECK_CMD[*]} in $tname exited $typecheck_status without reporting a diagnostic (see $typecheck_log)"
            echo "        A checker that fails without a diagnostic never read the payload, so this run proves nothing."
            tail -20 "$typecheck_log" | sed 's/^/    /'
            FAIL+=("$tname(typecheck:never-ran)")
            continue
        fi

        # Split the interleaved `--listFiles` output off into its own log. Every
        # listed path is absolute; every tsc diagnostic is relative to the scaffold,
        # so `^/` separates them cleanly. Worth the two lines: the file list runs to
        # ~1,800 entries and nobody should scroll past it to reach three errors.
        if [[ "$COVERAGE_MODE" == "listfiles" ]]; then
            grep -E '^/' "$typecheck_log" > "$coverage_log" || true
            grep -vE '^/' "$typecheck_log" > "${typecheck_log}.diagnostics" || true
            mv "${typecheck_log}.diagnostics" "$typecheck_log"
        fi

        ts_errors="$(grep -cE "$ERROR_RE" "$typecheck_log" || true)"

        # Vacuous-pass guard. A checker that reported diagnostics but named no FILE
        # in any of them never got as far as reading source: `tsc` aborts during
        # CONFIG resolution on e.g. `TS2688: Cannot find type definition file for
        # 'x'` — printed with no path, exit 1, ZERO files compiled.
        #
        # The count above cannot tell that apart from real type errors, and the
        # difference matters: a config abort means this run proves NOTHING about
        # the payload, whereas N real diagnostics mean it was read and found
        # wanting. Not hypothetical — `templates/react-router` listed
        # `@react-router/dev`, a package with no root type entry point, in its
        # tsconfig `types`, and its gate printed "typecheck OK" on every run from
        # the day it was added without ever having compiled one file.
        if [[ "$ts_errors" -gt 0 ]] && ! grep -qE "$FILE_RE" "$typecheck_log"; then
            echo "  FAIL: typecheck in $tname aborted before reading any file — $ts_errors diagnostic(s), none naming a file (see $typecheck_log)"
            echo "        A file-less diagnostic means the CHECKER is broken (bad tsconfig 'types'/'include',"
            echo "        missing prep step), so this run proves nothing about what it was meant to compile."
            grep -E "$ERROR_RE" "$typecheck_log" | head -10 | sed 's/^/    /'
            FAIL+=("$tname(typecheck:vacuous)")
            continue
        fi

        if [[ "$ts_errors" -gt 0 ]]; then
            echo "  FAIL: $ts_errors type error(s) in $tname (see $typecheck_log)"
            grep -E "$ERROR_RE" "$typecheck_log" | head -25 | sed 's/^/    /'
            FAIL+=("$tname(typecheck)")
            continue
        fi

        # -- coverage floor: prove the checker READ the payload ------------------
        # Everything above is a negative gate: it fires on diagnostics. A checker
        # that compiled NOTHING produces none, exits 0, and is indistinguishable
        # from a clean payload — `include` matching an empty set, a prep step that
        # wrote a tsconfig with the wrong roots, a framework that moved its
        # generated config. Same class as the config-abort the guard above catches,
        # one level deeper, and invisible to every counter here.
        #
        # So require positive evidence, in whichever form the checker can give it.
        if [[ "$COVERAGE_MODE" == "listfiles" ]]; then
            # `tsc`/`vue-tsc`: `--listFiles` already enumerated the program above.
            # Demand the two payload files the copy-in gate asserted on disk — the
            # shared core module and this framework's view.
            for covered in "lunora/auth-ui/core/sign-in.ts" "lunora/auth-ui/$authui_view"; do
                if ! grep -qF "/$covered" "$coverage_log"; then
                    echo "  FAIL: $tname typechecked without reading $covered — the gate above proved nothing (see $coverage_log)"
                    echo "        \`${TYPECHECK_CMD[*]}\` listed $(grep -c '' "$coverage_log" || true) file(s) in its program and that was not one of them."
                    echo "        Look at the tsconfig 'include'/'files' the checker resolved, and at whether the prep step wrote the config it expects."
                    FAIL+=("$tname(auth-ui:coverage)")
                    continue 2
                fi
            done

            echo "  ==> coverage OK ($(grep -c '/lunora/auth-ui/' "$coverage_log" || true) auth-ui file(s) in the program)"
        else
            # `astro check` / `svelte-check` publish no file list, so the only proof
            # left is to break the payload and require the complaint. Costs a second
            # checker pass; only these two templates pay it.
            #
            # BOTH payload files carry a canary, planted in the same pass, and BOTH
            # complaints are required — matching what `listfiles` demands of the
            # tsc-family checkers. The framework view needs its own canary because it
            # takes a DIFFERENT toolchain path than the plain `core/*.ts` module: a
            # `.svelte` view is only read via svelte2tsx, and `svelte-check` without
            # `--tsconfig` reads `.svelte` files and nothing else — so "reads the .ts"
            # and "parses the SFC" are two questions and either can be the one that
            # regresses. See plant_canary for where the canary lands in an SFC.
            canary_dir="$SCRATCH/${tname}-canary"
            # Backups outside the payload tree, not next to it: `allowJs`/`checkJs` are
            # on in some of these tsconfigs and a stray sibling is a needless risk.
            rm -rf "$canary_dir"
            mkdir -p "$canary_dir"
            canary_targets=("core/sign-in.ts" "$authui_view")

            plant_failed=""
            for rel in "${canary_targets[@]}"; do
                cp "$scaffold_dir/lunora/auth-ui/$rel" "$canary_dir/${rel//\//_}"
                plant_canary "$scaffold_dir/lunora/auth-ui/$rel" || plant_failed="$rel"
            done

            restore_canaries() {
                for rel in "${canary_targets[@]}"; do
                    cp "$canary_dir/${rel//\//_}" "$scaffold_dir/lunora/auth-ui/$rel"
                done
            }

            if [[ -n "$plant_failed" ]]; then
                restore_canaries
                echo "  FAIL: could not plant a coverage canary in lunora/auth-ui/$plant_failed ($tname)"
                FAIL+=("$tname(auth-ui:coverage)")
                continue
            fi

            echo "  ==> ${TYPECHECK_CMD[*]} again, against deliberately broken ${canary_targets[*]}"
            canary_started=$SECONDS
            (cd "$scaffold_dir" && "${TYPECHECK_CMD[@]}" 2>&1) \
                | sed -E "s/$(printf '\033')\[[0-9;]*m//g" > "$coverage_log" || true
            canary_elapsed=$((SECONDS - canary_started))

            restore_canaries

            canary_missed=()
            for rel in "${canary_targets[@]}"; do
                grep -qE "$(authui_file_re "$rel")" "$coverage_log" || canary_missed+=("$rel")
            done

            if [[ ${#canary_missed[@]} -gt 0 ]]; then
                echo "  FAIL: $tname did not report the type error(s) planted in ${canary_missed[*]} — the gate above proved nothing for ${canary_missed[*]} (see $coverage_log)"
                echo "        \`${TYPECHECK_CMD[*]}\` cannot be reading that file. Look at the tsconfig 'include'/'files' it resolved,"
                echo "        and at whether the prep step wrote the config it expects."
                FAIL+=("$tname(auth-ui:coverage)")
                continue
            fi

            # Print both passes' wall times. The canary pass is the whole price of
            # this coverage mode, and the first pass is the same work without it —
            # so the pair is the cost, not a number anyone has to re-derive.
            echo "  ==> coverage OK (planted errors in ${canary_targets[*]} were both reported; ${canary_elapsed}s for the canary pass vs ${typecheck_elapsed}s for the gate pass)"
        fi

        echo "  ==> typecheck OK"
    else
        # Fail closed. Reaching here means the detector resolved no view (every
        # other path out of that block `continue`s), so this template got NO
        # compiler over its source at all: the block above is the run's only
        # `tsc`, and `pnpm run build` compiles only what a build entry reaches —
        # every file under `lunora/` is tree-shaken away before a compiler sees
        # it. The build-LESS path above typechecks such a template; this one used
        # to record PASS on the bundler alone.
        #
        # Failing here rather than widening the AUTHUI_RESOLVED floor to "all
        # templates": that floor is a whole-run tripwire, so widening it makes
        # every verdict depend on the full matrix, while this fires per template
        # exactly where the coverage is lost. It is unreachable for the templates
        # on disk — `standalone` is the only one in this matrix that resolves no
        # view, and it ships no `build` script, so it takes the codegen +
        # typecheck path above (`expo` also resolves none, and is skipped before
        # it ever gets here). That is what makes this a guard and not a behaviour
        # change.
        echo "  FAIL: $tname resolved no auth-ui view, so nothing typechecked its source"
        echo "        \`pnpm run build\` bundles only what a build entry reaches, and this run's only"
        echo "        typechecker is gated on that view — so $tname would have recorded PASS with no"
        echo "        compiler having read lunora/ at all."
        echo "        Either teach the detector this template's framework (mirror detectAuthUiItem in"
        echo "        packages/cli/src/commands/add/features.ts) or drop its \`build\` script, which routes"
        echo "        it through the codegen + typecheck path instead."
        FAIL+=("$tname(typecheck:skipped)")
        continue
    fi

    if [[ $build_exit -eq 0 ]]; then
        # -- deploy dry run -------------------------------------------------
        # Only meaningful after a successful build: every deploy path here consumes
        # build output, so running it against a failed build would report the build
        # failure a second time in a less legible place. An XFAIL template (expected
        # build failure) never reaches this branch and is not asked to deploy.
        #
        # This template has a `build` script, so it emits a client bundle the deploy
        # has to carry.
        if ! run_deploy_dryrun "$tname" "$scaffold_dir" "$SCRATCH/${tname}-bundle" "$RESULTS_DIR/${tname}-deploy.log" "yes"; then
            FAIL+=("$tname(deploy)")
            continue
        fi

        DEPLOY_CHECKED+=("$tname")

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
    # A bare template name means the build step failed; anything else is recorded
    # as `<template>(<stage>)` and renders as `FAIL(<stage>)` — so a new stage
    # cannot show up in the table as "unknown".
    for f in "${FAIL[@]+"${FAIL[@]}"}"; do
        case "$f" in
            "$t") result="FAIL(build)" && break ;;
            "$t("*) result="FAIL${f#"$t"}" && break ;;
        esac
    done
    for x in "${XFAIL[@]+"${XFAIL[@]}"}"; do [[ "$x" == "$t" ]] && result="XFAIL(expected)" && break; done
    for x in "${XPASS[@]+"${XPASS[@]}"}"; do [[ "$x" == "$t" ]] && result="XPASS(unexpected)" && break; done
    printf "%-20s  %s\n" "$t" "$result"
done
echo ""
# A skipped template is not scaffolded, installed, built or typechecked by this
# run — and, for `expo`, by nothing else either (see SKIP_TEMPLATES). It never
# enters the table above, so without this line a green summary reads as coverage
# of every template in `templates/`, which it is not.
echo "  NOT COVERED: ${#SKIPPED[@]}   (${SKIPPED[*]+${SKIPPED[*]}}) — excluded from this matrix and gated by nothing else"
echo "  PASS     : ${#PASS[@]}   (${PASS[*]+${PASS[*]}})"
# A codegen+typecheck-only template is a weaker result than a built one — no
# bundler ever ran — and the table above renders both as plain PASS. Printed
# rather than failed: having no `build` script is legitimate for some frameworks,
# but a green summary must say which templates got the lighter treatment.
echo "  NO BUILD : ${#SKIP_BUILD[@]}   (${SKIP_BUILD[*]+${SKIP_BUILD[*]}})"
# The deploy gate is the only thing here that proves a scaffold can SHIP, and it
# is skipped for anything that failed earlier. Print who actually reached it, so
# a green summary cannot be read as deploy coverage of the whole matrix.
echo "  DEPLOYED : ${#DEPLOY_CHECKED[@]}   (${DEPLOY_CHECKED[*]+${DEPLOY_CHECKED[*]}}) — passed a credential-free deploy dry run"
echo "  XFAIL    : ${#XFAIL[@]}  (${XFAIL[*]+${XFAIL[*]}})"
echo "  FAIL     : ${#FAIL[@]}   (${FAIL[*]+${FAIL[*]}})"
echo "  XPASS    : ${#XPASS[@]}  (${XPASS[*]+${XPASS[*]}})"

# ---------------------------------------------------------------------------
# Exit code.
# ---------------------------------------------------------------------------
# The whole auth-ui half of the matrix is conditional on a non-empty detector
# result. If not one template produced one, every scaffold was graded on
# `pnpm run build` alone and the run is worthless — which is exactly how it would
# read if the detector broke for a reason that is the same for all of them (a
# moved `semver`, a renamed dependency, a typo in the mirror of
# `detectAuthUiItem`). A green summary must not be able to mean that.
if [[ ${#AUTHUI_RESOLVED[@]} -eq 0 ]]; then
    echo ""
    echo "FAILED — no template resolved an auth-ui view, so 'lunora add auth-ui', the payload"
    echo "         assertions, the per-template typecheck and its canary ran for none of them."
    echo "         Check the detector against detectAuthUiItem in packages/cli/src/commands/add/features.ts."
    exit 1
fi

echo "  auth-ui view resolved for ${#AUTHUI_RESOLVED[@]} of ${#TEMPLATES[@]} templates: ${AUTHUI_RESOLVED[*]}"

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
