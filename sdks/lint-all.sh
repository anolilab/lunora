#!/usr/bin/env bash
# Lint and format-check every SDK in parallel, one line per language.
#
# Same shape as `run-all.sh`: independent toolchains, per-language exit-status
# files rather than output grepping, and only a failing language prints a log.
#
#   ./sdks/lint-all.sh            # all seven
#   ./sdks/lint-all.sh go rust    # a subset
#
# WHAT IS CHECKED: the hand-written transports, their suites, and the consumer
# smoke programs under `sdks/smoke/<lang>/`. NOT generated output — the style of
# quicktype's models is not this repo's to own, and any correction there is undone
# by the next regeneration. The emitter is what enforces that output's shape;
# `packages/codegen/__tests__/sdk-targets.test.ts` is where it is asserted.
#
# The smoke programs are linted here even though they live outside every
# transport's own tree: they are the only code in this repo written against the
# VENDORED layout a consumer gets, so they are the closest thing to a worked
# example, and an example nobody formats rots.
#
# A missing tool is reported as SKIP, not PASS — a local run should say which
# check it did not actually perform.
#
# In CI, set SDK_LINT_REQUIRE_TOOLS=1 to turn SKIP into a failure. CI provides
# every tool deliberately, so a missing one there means the install broke, and a
# skipped check that exits 0 is a gate that reads green without having run.
set -uo pipefail

REQUIRE_TOOLS="${SDK_LINT_REQUIRE_TOOLS:-0}"

# The swift-format minor these Swift sources are formatted against. Six of the
# seven linters are pinned by the workflow's install step; swift-format ships no
# installable artifact, so its pin lives here — see the `swift)` leg.
#
# Overridable because the same release reports two different versions: the copy
# in a Swift toolchain prints `6.3.0`, a standalone build of the equivalent tag
# prints `603.0.0`. Whoever supplies a binary via SWIFT_FORMAT supplies the
# version to expect from it.
SWIFT_FORMAT_VERSION="${SWIFT_FORMAT_VERSION:-6.3}"

cd "$(dirname "$0")/.."
ROOT="$(pwd)"

# A Homebrew JDK is not on the default PATH, and neither is a user gem bin.
if [ -d /opt/homebrew/opt/openjdk/bin ]; then
    export PATH="/opt/homebrew/opt/openjdk/bin:$PATH"
fi

for gem_bin in /opt/homebrew/lib/ruby/gems/*/bin; do
    [ -d "$gem_bin" ] && export PATH="$gem_bin:$PATH"
done

ALL=(python go ruby rust swift java kotlin dart)

# ALL is hardcoded here, again in `generated-check.sh`, again in `run-all.sh`, and
# a fourth time as the CI matrix in `.github/workflows/test.yml` — so a ninth SDK
# missed in any one of them is silently never checked by that gate. Reconcile
# against what is actually on disk, which is the only copy that cannot be forgotten.
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
    printf 'sdks/lint-all.sh ALL and sdks/ disagree (left column: listed but absent; right: present but unlisted):\n%s\n' "$sdk_drift" >&2
    printf 'Update ALL here, ALL in sdks/generated-check.sh and sdks/run-all.sh, and the sdk-conformance matrix in .github/workflows/test.yml.\n' >&2
    exit 2
fi

LANGS=("$@")
if [ ${#LANGS[@]} -eq 0 ]; then
    LANGS=("${ALL[@]}")
fi

# A linter pointed at a tree with no matching sources exits 0 having linted
# nothing — `ruff check .`, `rubocop`, `dart analyze` and `swift format lint
# --recursive` all do. Empty the tree, move the sources, or rename the directory
# and the leg reports PASS. Only the kotlin leg guarded against this; this is the
# same guard, shared.
#
# Every input is held to at least one file individually: a total count would
# still pass while one of two or three inputs contributed nothing.
require_files() {
    local extension="$1"
    shift

    local input
    local found

    for input in "$@"; do
        found="$(find "$input" -name "*.$extension" 2>/dev/null | head -1)"

        if [ -z "$found" ]; then
            printf 'no *.%s files at %s — the linter would have reported PASS without reading it\n' "$extension" "$input"

            return 1
        fi
    done

    return 0
}

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# Reports a missing tool. Callers `return 3` after it — 3 means "not run", which
# is neither a pass nor a lint failure.
#
# NOT `return "$(missing x)"`: command substitution captures stdout, this writes
# to stderr, and `return ""` is a bash error that surfaces as status 1 — i.e. as a
# lint failure that names no offence.
missing() {
    echo "missing tool: $1" >&2
}

lint_suite() {
    case "$1" in
        python)
            command -v ruff >/dev/null || {
                missing ruff
                return 3
            }
            cd "$ROOT/sdks/python" || return 1
            require_files py . "$ROOT/sdks/smoke/python" || return 1
            # --config, because ruff resolves settings by walking up from each
            # FILE: the smoke lives outside this directory and would otherwise be
            # linted against defaults rather than the transport's own rules.
            ruff check . && ruff format --check . \
                && ruff check --config pyproject.toml "$ROOT/sdks/smoke/python" \
                && ruff format --check --config pyproject.toml "$ROOT/sdks/smoke/python"
            ;;
        go)
            command -v gofmt >/dev/null || {
                missing gofmt
                return 3
            }
            cd "$ROOT/sdks/go" || return 1
            # gofmt has no check mode: a non-empty file list IS the failure.
            local unformatted
            unformatted="$(gofmt -l lunora "$ROOT/sdks/smoke/go")"
            if [ -n "$unformatted" ]; then
                echo "gofmt would rewrite:"
                echo "$unformatted"
                return 1
            fi
            # No vet over the smoke: it imports `lunorasdk`, which only exists once
            # an SDK has been generated. `generated-check.sh` compiles it there,
            # and `go test` runs vet by default — so it is vetted, just not here.
            go vet ./lunora/...
            ;;
        ruby)
            command -v rubocop >/dev/null || {
                missing rubocop
                return 3
            }
            cd "$ROOT/sdks/ruby" || return 1
            require_files rb . "$ROOT/sdks/smoke/ruby" || return 1
            rubocop && rubocop --config .rubocop.yml "$ROOT/sdks/smoke/ruby"
            ;;
        rust)
            command -v cargo >/dev/null || {
                missing cargo
                return 3
            }
            cd "$ROOT/sdks/rust" || return 1
            # rustfmt directly for the smoke: it belongs to no crate in this repo
            # (its crate is assembled at check time), so `cargo fmt` cannot see it.
            # --config-path, because rustfmt discovers `rustfmt.toml` by walking up
            # from the FILE — outside this directory it would silently fall back to
            # defaults and hold the smoke to a narrower width than everything else.
            cargo fmt --check && cargo clippy --all-targets -- -D warnings \
                && rustfmt --check --edition 2021 --config-path rustfmt.toml "$ROOT/sdks/smoke/rust/generated_smoke.rs"
            ;;
        swift)
            # The one linter here with no install step, because there is nothing
            # to install: swiftlang/swift-format publishes no binary on any
            # release, and Homebrew carries a single unversioned formula. So the
            # tool is the Swift toolchain's own copy — `swift format`, a
            # subcommand from Swift 6.0 on — and the pin is the assertion below
            # instead of a version in the workflow.
            #
            # `swift format` resolves inside the toolchain and ignores a
            # `swift-format` on PATH, so SWIFT_FORMAT is the only way to point
            # this leg at another binary (a build from a pinned tag, say).
            local swift_format
            if [ -n "${SWIFT_FORMAT:-}" ]; then
                swift_format=("$SWIFT_FORMAT")
            else
                swift_format=(swift format)
            fi

            # A Swift 5.x toolchain has no `format` subcommand and fails here.
            # That is the same "not run" as a missing tool: a SKIP locally, and
            # under SDK_LINT_REQUIRE_TOOLS=1 a failure naming what was wanted.
            local swift_format_version
            swift_format_version="$("${swift_format[@]}" --version 2>/dev/null)" || {
                missing "${swift_format[*]} (this repo pins swift-format ${SWIFT_FORMAT_VERSION}.x, which ships with a Swift ${SWIFT_FORMAT_VERSION} toolchain)"
                return 3
            }

            # A different minor is a different rule set, which is exactly what
            # the other six pins prevent. The runner image's default Xcode moves
            # on GitHub's schedule, so this drift is real and must be loud.
            local swift_format_drifted=0
            local swift_format_note="swift-format $swift_format_version"

            if [ "${swift_format_version%.*}" != "$SWIFT_FORMAT_VERSION" ]; then
                swift_format_drifted=1
                swift_format_note="$swift_format_note, NOT the pinned $SWIFT_FORMAT_VERSION.x"
            fi

            # Reported, not merely checked: the sibling legs' versions are in
            # their install step's log, and this leg has no install step to read.
            # The note reaches the summary line, which a green run prints too.
            printf '%s\n' "$swift_format_note" >"$WORK/swift.tool"

            if [ "$swift_format_drifted" = 1 ]; then
                printf '%s\n' \
                    "swift-format $swift_format_version, but these sources are formatted against ${SWIFT_FORMAT_VERSION}.x — a different minor is a different rule set." \
                    "Verify the new rule set, then bump SWIFT_FORMAT_VERSION in sdks/lint-all.sh — or run SWIFT_FORMAT=<binary> SWIFT_FORMAT_VERSION=<its minor> to lint with a pinned build."

                # Enforced only where the pin is the point. In CI that is the
                # gate. Locally the summary line says which version ran and the
                # lint proceeds — an unpinned rule set still catches the mistake
                # the run was for, and not every contributor has this Xcode.
                if [ "$REQUIRE_TOOLS" = "1" ]; then
                    return 1
                fi
            fi

            cd "$ROOT/sdks/swift" || return 1
            require_files swift Sources/Lunora Tests "$ROOT/sdks/smoke/swift" || return 1
            # --configuration for the same reason rustfmt needs --config-path: the
            # smoke sits outside this directory, and swift-format finds
            # `.swift-format` by walking up from the file.
            "${swift_format[@]}" lint --recursive --strict Sources/Lunora Tests \
                && "${swift_format[@]}" lint --recursive --strict --configuration .swift-format "$ROOT/sdks/smoke/swift"
            ;;
        java)
            command -v google-java-format >/dev/null || {
                missing google-java-format
                return 3
            }
            cd "$ROOT/sdks/java" || return 1
            # --aosp for 4-space indentation, matching every sibling port.
            google-java-format --aosp --dry-run --set-exit-if-changed \
                src/dev/lunora/*.java test/dev/lunora/*.java "$ROOT"/sdks/smoke/java/*.java \
                && javac -Xlint:all -Werror -d "$WORK/javalint" src/dev/lunora/*.java test/dev/lunora/*.java
            ;;
        kotlin)
            command -v ktlint >/dev/null || {
                missing ktlint
                return 3
            }
            cd "$ROOT/sdks/kotlin" || return 1
            # ktlint exits 0 when a glob matches nothing — it only warns "No files
            # matched", so moving or renaming a source file would leave this leg
            # green without linting it. Resolve the paths here instead, and hold
            # every input to at least one file: a total count would still pass
            # while one of the three inputs contributed nothing.
            local kotlin_files=()
            local kotlin_input

            for kotlin_input in src test "$ROOT/sdks/smoke/kotlin"; do
                local kotlin_found=()

                while IFS= read -r kotlin_file; do
                    kotlin_found+=("$kotlin_file")
                done < <(find "$kotlin_input" -name '*.kt' 2>/dev/null | sort)

                if [ "${#kotlin_found[@]}" -eq 0 ]; then
                    printf 'no .kt files at %s — ktlint would have reported PASS without linting it\n' "$kotlin_input"

                    return 1
                fi

                kotlin_files+=("${kotlin_found[@]}")
            done

            ktlint "${kotlin_files[@]}"
            ;;
        dart)
            command -v dart >/dev/null || {
                missing dart
                return 3
            }
            cd "$ROOT/sdks/dart" || return 1
            require_files dart lib test "$ROOT/sdks/smoke/dart" || return 1
            # `pub get` first: `dart analyze` resolves `package:lunora/…` through
            # .dart_tool/package_config.json, which is gitignored. --offline
            # because this package declares no dependencies, so a lint run must
            # never be able to reach the network.
            #
            # --language-version, for the same reason rustfmt needs --config-path
            # and ruff needs --config: `dart format`'s style is chosen by the SDK
            # constraint in the nearest pubspec, the smoke lives outside this
            # package, and there is no pubspec above `sdks/smoke/`. Left to
            # discovery the smoke would be formatted against the LATEST style
            # while the transport is formatted against 3.6 — two rule sets in one
            # leg. Keep this in step with `sdks/dart/pubspec.yaml`.
            #
            # --fatal-infos, because `dart analyze` exits 0 on an info-level lint
            # by default: without it every rule in `analysis_options.yaml` that
            # reports at info — which is most of them — would be advisory.
            dart pub get --offline >/dev/null \
                && dart format --output=none --set-exit-if-changed --line-length=160 --language-version=3.6 lib test \
                && dart analyze --fatal-infos \
                && dart format --output=none --set-exit-if-changed --line-length=160 --language-version=3.6 "$ROOT/sdks/smoke/dart"
            # No `dart analyze` over the smoke: it imports `package:lunora_sdk`,
            # which only exists once an SDK has been generated. `generated-check.sh`
            # analyses it there — the same split the go leg makes for `go vet`.
            ;;
        *)
            echo "unknown language: $1" >&2
            return 2
            ;;
    esac
}

for lang in "${LANGS[@]}"; do
    {
        lint_suite "$lang" >"$WORK/$lang.log" 2>&1
        echo "$?" >"$WORK/$lang.status"
    } &
done

wait

failed=0

for lang in "${LANGS[@]}"; do
    status="$(cat "$WORK/$lang.status" 2>/dev/null || echo 1)"

    # A leg whose tool version is not fixed by an install step writes it to
    # `$lang.tool`, so even a green log records which rule set ran.
    tool=""
    if [ -s "$WORK/$lang.tool" ]; then
        tool=" [$(cat "$WORK/$lang.tool")]"
    fi

    case "$status" in
        0) printf 'PASS  %s%s\n' "$lang" "$tool" ;;
        3)
            if [ "$REQUIRE_TOOLS" = "1" ]; then
                printf 'FAIL  %s (%s, and SDK_LINT_REQUIRE_TOOLS=1)\n' "$lang" "$(head -1 "$WORK/$lang.log")"
                failed=1
            else
                printf 'SKIP  %s (%s)\n' "$lang" "$(head -1 "$WORK/$lang.log")"
            fi
            ;;
        *)
            printf 'FAIL  %s%s (exit %s)\n' "$lang" "$tool" "$status"
            failed=1
            ;;
    esac
done

if [ "$failed" -ne 0 ]; then
    for lang in "${LANGS[@]}"; do
        status="$(cat "$WORK/$lang.status" 2>/dev/null || echo 1)"

        if [ "$status" != "0" ] && { [ "$status" != "3" ] || [ "$REQUIRE_TOOLS" = "1" ]; }; then
            printf '\n===== %s =====\n' "$lang"
            tail -30 "$WORK/$lang.log"
        fi
    done
fi

exit "$failed"
