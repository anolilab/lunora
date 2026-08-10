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
# In CI, set SDK_LINT_REQUIRE_TOOLS=1 to turn SKIP into a failure. CI installs
# every tool deliberately, so a missing one there means the install broke, and a
# skipped check that exits 0 is a gate that reads green without having run.
set -uo pipefail

REQUIRE_TOOLS="${SDK_LINT_REQUIRE_TOOLS:-0}"

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
            # `swift format` is a toolchain subcommand from Swift 6.0 on; before
            # that it is a separate `swift-format` install. Probing the subcommand
            # keeps an older toolchain a SKIP rather than a bogus lint failure.
            swift format --version >/dev/null 2>&1 || {
                missing "swift format"
                return 3
            }
            cd "$ROOT/sdks/swift" || return 1
            swift format lint --recursive --strict Sources/Lunora Tests
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

    case "$status" in
        0) printf 'PASS  %s\n' "$lang" ;;
        3)
            if [ "$REQUIRE_TOOLS" = "1" ]; then
                printf 'FAIL  %s (%s, and SDK_LINT_REQUIRE_TOOLS=1)\n' "$lang" "$(head -1 "$WORK/$lang.log")"
                failed=1
            else
                printf 'SKIP  %s (%s)\n' "$lang" "$(head -1 "$WORK/$lang.log")"
            fi
            ;;
        *)
            printf 'FAIL  %s (exit %s)\n' "$lang" "$status"
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
