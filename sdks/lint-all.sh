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
# A missing tool is reported as SKIP, not PASS — CI installs all of them, and a
# local run should say which check it did not actually perform.
set -uo pipefail

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

# 3 = the tool is missing, which is neither a pass nor a lint failure.
missing() {
    echo "missing tool: $1" >&2
    return 3
}

lint_suite() {
    case "$1" in
        python)
            command -v ruff >/dev/null || return "$(missing ruff)"
            cd "$ROOT/sdks/python" || return 1
            ruff check . && ruff format --check .
            ;;
        go)
            command -v gofmt >/dev/null || return "$(missing gofmt)"
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
            command -v rubocop >/dev/null || return "$(missing rubocop)"
            cd "$ROOT/sdks/ruby" || return 1
            rubocop
            ;;
        rust)
            command -v cargo >/dev/null || return "$(missing cargo)"
            cd "$ROOT/sdks/rust" || return 1
            cargo fmt --check && cargo clippy --all-targets -- -D warnings
            ;;
        swift)
            # `swift format` is a toolchain subcommand from Swift 6.0 on; before
            # that it is a separate `swift-format` install. Probing the subcommand
            # keeps an older toolchain a SKIP rather than a bogus lint failure.
            swift format --version >/dev/null 2>&1 || return "$(missing 'swift format')"
            cd "$ROOT/sdks/swift" || return 1
            swift format lint --recursive --strict Sources/Lunora Tests
            ;;
        java)
            command -v google-java-format >/dev/null || return "$(missing google-java-format)"
            cd "$ROOT/sdks/java" || return 1
            # --aosp for 4-space indentation, matching every sibling port.
            google-java-format --aosp --dry-run --set-exit-if-changed \
                src/dev/lunora/*.java test/dev/lunora/*.java generated_check/GeneratedSmoke.java \
                && javac -Xlint:all -Werror -d "$WORK/javalint" src/dev/lunora/*.java test/dev/lunora/*.java
            ;;
        kotlin)
            command -v ktlint >/dev/null || return "$(missing ktlint)"
            cd "$ROOT/sdks/kotlin" || return 1
            ktlint "src/**/*.kt" "test/**/*.kt" "GeneratedSmoke.kt"
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
            printf 'SKIP  %s (%s)\n' "$lang" "$(head -1 "$WORK/$lang.log")"
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

        if [ "$status" != "0" ] && [ "$status" != "3" ]; then
            printf '\n===== %s =====\n' "$lang"
            tail -30 "$WORK/$lang.log"
        fi
    done
fi

exit "$failed"
