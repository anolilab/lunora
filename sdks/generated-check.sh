#!/usr/bin/env bash
# Generate an SDK into a scratch directory OUTSIDE this repo, then compile and RUN
# a call from a throwaway consumer project.
#
#   ./sdks/generated-check.sh python        # one language
#   ./sdks/generated-check.sh               # all eight, sequentially
#
# WHY OUTSIDE THE REPO. `lunora sdk generate` now COPIES the transport into its
# output, so the promise under test is "this directory runs with no Lunora package
# installed anywhere". Inside the checkout that promise cannot be tested: every
# language resolves `sdks/<lang>` by accident — Python finds `sdks/python/lunora`
# on sys.path, Go finds the sibling package in the same module, Swift finds the
# target in the same SwiftPM package. A pass there would prove nothing. So the
# output goes to `mktemp -d`, and each consumer project below wires it up the way
# a real consumer does and no other way.
#
# WHY IT ALSO CALLS. Building is not sufficient, and that is measured rather than
# assumed: Java once emitted a surface that compiled and threw `cannot encode` on
# the first invocation, Ruby one whose every method raised NoMethodError, and Rust
# one that sent `"limit": null` for an unset optional. Every leg runs two smoke
# programs from `sdks/smoke/<lang>/`: `generated_smoke` asserts the frame
# {"args":{"channelId":"chan_1"},"functionPath":"messages:list"}, and
# `surface_smoke` calls every function of the `sdk-surface` spec (see
# SURFACE_SPEC below) and asserts both its frame and its decoded result.
#
# --from, not a tag. The fetch defaults to the CLI's own release tag, so without
# this CI would exercise whatever transports that published tag carries rather than
# the ones in the checkout under test. So this passes `--from sdks` and copies from
# the checkout. The remote path is exercised by generating without it.
set -uo pipefail

cd "$(dirname "$0")/.."
ROOT="$(pwd)"

# A Homebrew JDK is not on the default PATH, and Kotlin needs it too. Same
# prelude as run-all.sh / lint-all.sh.
if [ -d /opt/homebrew/opt/openjdk/bin ]; then
    export PATH="/opt/homebrew/opt/openjdk/bin:$PATH"
fi

CLI="$ROOT/packages/cli/dist/bin.mjs"
SPEC="$ROOT/packages/codegen/__tests__/fixtures/simple/expected/_generated/openrpc.json"

# The SECOND suite, and the reason each leg runs twice. `simple` exercises the
# call path, but its results are untyped and every argument is a plain object, so
# it never reaches the parts of a model backend that differ by SHAPE — and six
# defects shipped there with this script green: a `v.bigint()` given a string
# model, a Ruby decode calling a method only struct classes have, Swift
# redeclaring one helper per `[String]` result, a nullable-object result naming a
# type found only in a comment, a Dart cast of a list to a map, and a Rust
# `subscribe_r#match`. `sdk-surface` declares one function per shape (no-arg,
# id, number, array, record, null, nullable object, array of objects, a union,
# bigint at the top level and nested, keyword names), and it is the emitter's
# real output — a golden the codegen tests hold to the emitter — never a
# hand-written spec that can drift from what users get.
SURFACE_SPEC="$ROOT/packages/codegen/__tests__/fixtures/sdk-surface/expected/_generated/openrpc.json"

if [ ! -f "$CLI" ]; then
    echo "no built CLI at $CLI — run: pnpm exec vis run build --query 'project=cli'" >&2
    exit 2
fi

ALL=(python go ruby rust swift java kotlin dart)

# ALL is hardcoded here, again in `lint-all.sh`, again in `run-all.sh`, and a fourth
# time as the CI matrix in `.github/workflows/test.yml` — so a ninth SDK missed in
# any one of them is silently never checked by that gate. Reconcile against what is
# actually on disk, which is the only copy that cannot be forgotten. Same block as
# lint-all.sh and run-all.sh, on purpose: four copies of one list need one
# reconciliation idiom, not four.
# Everything under sdks/ is a port unless it is listed here. An explicit ignore
# list rather than a marker-file heuristic: a marker SKIPS what it does not
# match, so a new port that forgot the marker is absent from both this list and
# ALL — no drift, silently never checked. This way a directory that is not a port
# costs one deliberate line, and anything else fails loudly.
IGNORED=(smoke)

DISCOVERED=()
for sdk_dir in "$ROOT"/sdks/*/; do
    sdk_name="$(basename "$sdk_dir")"
    skip=""
    for ignored in "${IGNORED[@]}"; do
        [ "$sdk_name" = "$ignored" ] && skip=1 && break
    done
    [ -n "$skip" ] && continue
    DISCOVERED+=("$sdk_name")
done

sdk_drift="$(comm -3 <(printf '%s\n' "${ALL[@]}" | sort) <(printf '%s\n' "${DISCOVERED[@]}" | sort))"
if [ -n "$sdk_drift" ]; then
    printf 'sdks/generated-check.sh ALL and sdks/ disagree (left column: listed but absent; right: present but unlisted):\n%s\n' "$sdk_drift" >&2
    printf 'Update ALL here, ALL in sdks/lint-all.sh and sdks/run-all.sh, and the sdk-conformance matrix in .github/workflows/test.yml.\n' >&2
    exit 2
fi

LANGS=("$@")
if [ ${#LANGS[@]} -eq 0 ]; then
    LANGS=("${ALL[@]}")
fi

# Assembles the consumer project for one language in $WORK/app and runs it.
# $OUT is the generated SDK; nothing else about the repo is on any search path.
# $SUITE picks the smoke program: `generated` (the `simple` spec) or `surface`
# (the `sdk-surface` spec) — `sdks/smoke/<lang>/<suite>_smoke.*`, or
# `<Suite>Smoke.*` where the language names files after their class.
run_consumer() {
    local lang="$1" work="$2" out="$3" suite="$4"
    local app="$work/app"
    local Suite
    Suite="$(printf '%s' "${suite:0:1}" | tr '[:lower:]' '[:upper:]')${suite:1}"

    mkdir -p "$app"

    case "$lang" in
        # Two sibling packages under one sys.path entry, so one insert reaches both.
        python)
            LUNORA_SDK_OUT="$out" python3 "$ROOT/sdks/smoke/python/${suite}_smoke.py"
            ;;
        # The two lines a consuming module writes. `replace` means the unpublished
        # module path is never resolved against a proxy.
        go)
            {
                echo "module lunorasmoke"
                echo
                echo "go 1.22"
                echo
                echo "require lunorasdk v0.0.0"
                echo
                echo "replace lunorasdk => $out"
            } >"$app/go.mod" \
                && cp "$ROOT/sdks/smoke/go/${suite}_smoke_test.go" "$app/" \
                && (cd "$app" && go test ./... -count=1)
            ;;
        # `require "lunora"` and `require "api"` both resolve off the one load-path
        # entry the smoke adds, which is the output directory.
        ruby)
            LUNORA_SDK_OUT="$out" ruby "$ROOT/sdks/smoke/ruby/${suite}_smoke.rb"
            ;;
        # A path dependency on the generated crate, plus one on the transport
        # vendored beneath it, because the smoke names both.
        #
        # `src/lib.rs` is empty on purpose: the assertion is an integration test
        # and a package needs some target for cargo to build one.
        #
        # `--test generated_smoke` names the target rather than letting `cargo
        # test` run whatever it finds, because whatever it finds may be nothing:
        # a bare `cargo test` over a crate whose `tests/` is empty reports "0
        # passed" and exits 0, so a smoke file that failed to copy read as a
        # PASS. Naming the target makes its absence "no test target named
        # `generated_smoke`" and a non-zero exit. The `&&` chain closes the same
        # hole one step earlier — this script runs without `set -e`, so an
        # unchained `cp` failure was simply stepped over.
        rust)
            {
                echo '[package]'
                echo 'name = "lunora-smoke"'
                echo 'version = "0.1.0"'
                echo 'edition = "2021"'
                echo 'publish = false'
                echo
                echo '[workspace]'
                echo
                echo '[dependencies]'
                echo "lunora-api = { path = \"$out\" }"
                echo "lunora = { path = \"$out/lunora\" }"
                echo 'serde_json = "1"'
            } >"$app/Cargo.toml"
            mkdir -p "$app/src" "$app/tests" \
                && : >"$app/src/lib.rs" \
                && cp "$ROOT/sdks/smoke/rust/${suite}_smoke.rs" "$app/tests/" \
                && (cd "$app" && cargo test --quiet --test "${suite}_smoke")
            ;;
        # `.package(path:)` on the generated package, then both products by
        # `.product(name:package:)` — where `package:` is the output DIRECTORY's
        # name ("sdk", set by check_one below), because that is what SwiftPM uses
        # as a path dependency's identity. It ignores the manifest's own `name:`,
        # and a bare product name does not resolve at all; both were measured
        # against a real generated package, and `targets/swift.ts` records them.
        swift)
            {
                echo '// swift-tools-version:5.9'
                echo 'import PackageDescription'
                echo 'let package = Package('
                echo '    name: "LunoraSmoke",'
                echo '    platforms: [.macOS(.v12)],'
                echo "    dependencies: [.package(path: \"$out\")],"
                echo '    targets: ['
                echo '        .executableTarget('
                echo '            name: "LunoraSmoke",'
                echo '            dependencies: ['
                echo "                .product(name: \"LunoraApi\", package: \"$(basename "$out")\"),"
                echo "                .product(name: \"Lunora\", package: \"$(basename "$out")\"),"
                echo '            ]'
                echo '        )'
                echo '    ]'
                echo ')'
            } >"$app/Package.swift" \
                && mkdir -p "$app/Sources/LunoraSmoke" \
                && cp "$ROOT/sdks/smoke/swift/${suite}_smoke.swift" "$app/Sources/LunoraSmoke/main.swift" \
                && (cd "$app" && swift run LunoraSmoke)
            ;;
        # The generated tree as the ONLY source path: javac compiles `dev.lunora`
        # and `lunoraapi` out of it on demand, with nothing on the classpath.
        java)
            javac -Xlint:all -sourcepath "$out" -d "$app/classes" "$ROOT/sdks/smoke/java/${Suite}Smoke.java" \
                && java -cp "$app/classes" "${Suite}Smoke"
            ;;
        # kotlinc takes the generated tree as a source directory; packages come
        # from the declarations, so no layout flag is needed.
        kotlin)
            kotlinc "$out" "$ROOT/sdks/smoke/kotlin/${Suite}Smoke.kt" -include-runtime -d "$app/smoke.jar" -nowarn \
                && java -cp "$app/smoke.jar" "dev.lunora.${Suite}SmokeKt"
            ;;
        # A path dependency, which is the one stanza a consumer writes. pub takes
        # a path dependency's identity from the DEPENDED-ON pubspec's `name:`, so
        # `lunora_sdk` below is the emitted manifest's name and not the output
        # directory's — the opposite of SwiftPM, and the reason this leg needs no
        # `basename` the way the swift one does.
        #
        # Analysed in BOTH directories, and the first is the one that matters.
        # `dart analyze` only reports on the package it is run in: from the
        # consumer it type-checks the smoke's use of the surface but stays silent
        # about the surface itself, so a generated method the smoke does not call
        # could reference an undefined type and still pass — measured, not
        # assumed. Running it inside the generated package is the counterpart of
        # `swift build`, and it covers quicktype's models too. A generated package
        # carries no analysis_options.yaml, so this is the default error/warning
        # set with no style lints, which is exactly right for output whose style
        # this repo does not own.
        #
        # Keep this prose OUT of the `&&` chain below. A `\` continuation followed
        # by a comment terminates the command, so a comment spliced mid-chain
        # silently detaches everything after it — which is how the analysis ran
        # unchained from its `cp` here, in the one leg this script exists to gate.
        dart)
            {
                echo 'name: lunora_smoke'
                echo 'publish_to: none'
                echo 'environment:'
                echo '    sdk: ^3.6.0'
                echo 'dependencies:'
                echo '    lunora_sdk:'
                echo "        path: $out"
            } >"$app/pubspec.yaml" \
                && mkdir -p "$app/bin" \
                && cp "$ROOT/sdks/smoke/dart/${suite}_smoke.dart" "$app/bin/" \
                && (cd "$out" && dart pub get --offline && dart analyze) \
                && (cd "$app" && dart pub get --offline && dart analyze && dart run "bin/${suite}_smoke.dart")
            ;;
        *)
            echo "unknown language: $lang" >&2
            return 2
            ;;
    esac
}

check_one() {
    local lang="$1" suite="$2"
    local work

    work="$(mktemp -d)"

    # `sdk` under the temp root, never the temp root itself: the consumer project
    # is a sibling, and a generator writing into a directory that also holds the
    # consumer's manifests is not the layout a user gets.
    local out="$work/sdk"

    local spec="$SURFACE_SPEC"

    # A `generated` leg may append methods the shared fixture has none of, from
    # `sdks/smoke/<lang>/extra-methods.json` — swift's typed-result call site,
    # which the fixture's untyped results never generate. Appended at run time
    # rather than kept as a second copy of the spec, which would drift from it.
    if [ "$suite" = generated ]; then
        spec="$SPEC"

        local extra="$ROOT/sdks/smoke/$lang/extra-methods.json"

        if [ -f "$extra" ]; then
            spec="$work/openrpc.json"
            node -e 'const fs = require("node:fs"); const [base, extra, out] = process.argv.slice(1); const doc = JSON.parse(fs.readFileSync(base, "utf8")); doc.methods.push(...JSON.parse(fs.readFileSync(extra, "utf8"))); fs.writeFileSync(out, JSON.stringify(doc));' "$SPEC" "$extra" "$spec"
        fi
    fi

    [ -f "$spec" ] \
        && node "$CLI" sdk generate --lang "$lang" --spec "$spec" --out "$out" --from "$ROOT/sdks" \
        && run_consumer "$lang" "$work" "$out" "$suite"

    local status=$?

    rm -rf "$work"

    return "$status"
}

failed=0

for lang in "${LANGS[@]}"; do
    printf '===== %s =====\n' "$lang"

    for suite in generated surface; do
        if check_one "$lang" "$suite"; then
            printf 'PASS  %s (%s)\n\n' "$lang" "$suite"
        else
            printf 'FAIL  %s (%s)\n\n' "$lang" "$suite"
            failed=1
        fi
    done
done

exit "$failed"
