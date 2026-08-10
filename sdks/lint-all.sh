#!/usr/bin/env bash
# Lint and format-check every SDK in parallel, one line per language.
#
# Same shape as `run-all.sh`: independent toolchains, per-language exit-status
# files rather than output grepping, and only a failing language prints a log.
#
#   ./sdks/lint-all.sh            # all seven
#   ./sdks/lint-all.sh go rust    # a subset
#
# WHAT IS CHECKED: the hand-written transports, their suites, and the
# `generated_smoke.*` programs. NOT the `generated_check/` trees — those are
# `lunora sdk generate` output committed as samples, their models come from
# quicktype (whose style this repo does not own), and any correction there is
# undone by the next regeneration. The emitter is what enforces that output's
# shape; `packages/codegen/__tests__/sdk-targets.test.ts` is where it is asserted.
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

ALL=(python go ruby rust swift java kotlin)
LANGS=("$@")
if [ ${#LANGS[@]} -eq 0 ]; then
    LANGS=("${ALL[@]}")
fi

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
            ruff check . && ruff format --check .
            ;;
        go)
            command -v gofmt >/dev/null || {
                missing gofmt
                return 3
            }
            cd "$ROOT/sdks/go" || return 1
            # gofmt has no check mode: a non-empty file list IS the failure.
            local unformatted
            unformatted="$(gofmt -l lunora smoke)"
            if [ -n "$unformatted" ]; then
                echo "gofmt would rewrite:"
                echo "$unformatted"
                return 1
            fi
            go vet ./lunora/... && go vet -tags generatedcheck ./smoke/...
            ;;
        ruby)
            command -v rubocop >/dev/null || {
                missing rubocop
                return 3
            }
            cd "$ROOT/sdks/ruby" || return 1
            rubocop
            ;;
        rust)
            command -v cargo >/dev/null || {
                missing cargo
                return 3
            }
            cd "$ROOT/sdks/rust" || return 1
            cargo fmt --check && cargo clippy --all-targets -- -D warnings
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
            "${swift_format[@]}" lint --recursive --strict Sources/Lunora Tests
            ;;
        java)
            command -v google-java-format >/dev/null || {
                missing google-java-format
                return 3
            }
            cd "$ROOT/sdks/java" || return 1
            # --aosp for 4-space indentation, matching every sibling port.
            google-java-format --aosp --dry-run --set-exit-if-changed \
                src/dev/lunora/*.java test/dev/lunora/*.java generated_check/GeneratedSmoke.java \
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

            for kotlin_input in src test GeneratedSmoke.kt; do
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
