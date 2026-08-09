#!/usr/bin/env bash
# Run every SDK's conformance suite in parallel and report one line per language.
#
# The suites are genuinely independent — seven toolchains reading the same
# read-only fixtures — so there is nothing to serialise. Sequentially the run is
# the sum of seven compilers; in parallel it costs about the slowest one.
#
#   ./sdks/run-all.sh            # all seven
#   ./sdks/run-all.sh go rust    # a subset
#
# Exits non-zero if any language fails, and prints the tail of a failing log
# only for the languages that failed, so a green run stays one screen.
set -uo pipefail

cd "$(dirname "$0")/.."
ROOT="$(pwd)"

# A Homebrew JDK is not on the default PATH, and Kotlin needs it too.
if [ -d /opt/homebrew/opt/openjdk/bin ]; then
    export PATH="/opt/homebrew/opt/openjdk/bin:$PATH"
fi

ALL=(python go ruby rust swift java kotlin)
LANGS=("$@")
if [ ${#LANGS[@]} -eq 0 ]; then
    LANGS=("${ALL[@]}")
fi

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

run_suite() {
    case "$1" in
        python) (cd "$ROOT/sdks/python" && python3 -m unittest discover -s tests -t .) ;;
        go) (cd "$ROOT/sdks/go" && go test ./... -race) ;;
        ruby) (cd "$ROOT/sdks/ruby" && ruby -Ilib -e 'Dir["test/test_*.rb"].each { |f| require File.expand_path(f) }') ;;
        rust) (cd "$ROOT/sdks/rust" && cargo test) ;;
        swift) (cd "$ROOT/sdks/swift" && swift test) ;;
        java) (cd "$ROOT/sdks/java" && bash build.sh) ;;
        kotlin) (cd "$ROOT/sdks/kotlin" && bash build.sh) ;;
        *)
            echo "unknown language: $1" >&2
            return 2
            ;;
    esac
}

# Each job records its own exit status. `wait -n` is unavailable on the bash 3.2
# macOS ships, and parsing suite output for a pass marker would differ per
# language and silently mis-read a new one — the status file cannot.
for lang in "${LANGS[@]}"; do
    {
        run_suite "$lang" >"$WORK/$lang.log" 2>&1
        echo "$?" >"$WORK/$lang.status"
    } &
done

wait

failed=0

for lang in "${LANGS[@]}"; do
    status="$(cat "$WORK/$lang.status" 2>/dev/null || echo 1)"

    if [ "$status" -eq 0 ]; then
        printf 'PASS  %s\n' "$lang"
    else
        printf 'FAIL  %s (exit %s)\n' "$lang" "$status"
        failed=1
    fi
done

if [ "$failed" -ne 0 ]; then
    for lang in "${LANGS[@]}"; do
        status="$(cat "$WORK/$lang.status" 2>/dev/null || echo 1)"

        if [ "$status" -ne 0 ]; then
            printf '\n===== %s =====\n' "$lang"
            tail -25 "$WORK/$lang.log"
        fi
    done
fi

exit "$failed"
