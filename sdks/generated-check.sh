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
# one that sent `"limit": null` for an unset optional. Every leg asserts the same
# frame — {"args":{"channelId":"chan_1"},"functionPath":"messages:list"} — which
# the smoke programs under `sdks/smoke/<lang>/` do.
#
# --from, not a tag. The fetch defaults to the CLI's own release tag, and six of
# the seven transports do not exist at any released tag yet. CI must not depend on
# one, so this passes `--from sdks` and copies from the checkout. The remote path
# is exercised by generating without it.
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
run_consumer() {
    local lang="$1" work="$2" out="$3"
    local app="$work/app"

    mkdir -p "$app"

    case "$lang" in
        # Two sibling packages under one sys.path entry, so one insert reaches both.
        python)
            LUNORA_SDK_OUT="$out" python3 "$ROOT/sdks/smoke/python/generated_smoke.py"
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
                && cp "$ROOT/sdks/smoke/go/generated_smoke_test.go" "$app/" \
                && (cd "$app" && go test ./... -count=1)
            ;;
        # `require "lunora"` and `require "api"` both resolve off the one load-path
        # entry the smoke adds, which is the output directory.
        ruby)
            LUNORA_SDK_OUT="$out" ruby "$ROOT/sdks/smoke/ruby/generated_smoke.rb"
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
                && cp "$ROOT/sdks/smoke/rust/generated_smoke.rs" "$app/tests/" \
                && (cd "$app" && cargo test --quiet --test generated_smoke)
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
                && cp "$ROOT/sdks/smoke/swift/main.swift" "$app/Sources/LunoraSmoke/" \
                && (cd "$app" && swift run LunoraSmoke)
            ;;
        # The generated tree as the ONLY source path: javac compiles `dev.lunora`
        # and `lunoraapi` out of it on demand, with nothing on the classpath.
        java)
            javac -Xlint:all -sourcepath "$out" -d "$app/classes" "$ROOT/sdks/smoke/java/GeneratedSmoke.java" \
                && java -cp "$app/classes" GeneratedSmoke
            ;;
        # kotlinc takes the generated tree as a source directory; packages come
        # from the declarations, so no layout flag is needed.
        kotlin)
            kotlinc "$out" "$ROOT/sdks/smoke/kotlin/GeneratedSmoke.kt" -include-runtime -d "$app/smoke.jar" -nowarn \
                && java -cp "$app/smoke.jar" dev.lunora.GeneratedSmokeKt
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
                && cp "$ROOT/sdks/smoke/dart/generated_smoke.dart" "$app/bin/" \
                && (cd "$out" && dart pub get --offline && dart analyze) \
                && (cd "$app" && dart pub get --offline && dart analyze && dart run bin/generated_smoke.dart)
            ;;
        *)
            echo "unknown language: $lang" >&2
            return 2
            ;;
    esac
}

check_one() {
    local lang="$1"
    local work

    work="$(mktemp -d)"

    # `sdk` under the temp root, never the temp root itself: the consumer project
    # is a sibling, and a generator writing into a directory that also holds the
    # consumer's manifests is not the layout a user gets.
    local out="$work/sdk"

    node "$CLI" sdk generate --lang "$lang" --spec "$SPEC" --out "$out" --from "$ROOT/sdks" \
        && run_consumer "$lang" "$work" "$out"

    local status=$?

    rm -rf "$work"

    return "$status"
}

failed=0

for lang in "${LANGS[@]}"; do
    printf '===== %s =====\n' "$lang"

    if check_one "$lang"; then
        printf 'PASS  %s\n\n' "$lang"
    else
        printf 'FAIL  %s\n\n' "$lang"
        failed=1
    fi
done

exit "$failed"
