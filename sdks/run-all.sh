#!/usr/bin/env bash
# Run every SDK's conformance suite in parallel and report one line per language.
#
# The suites are genuinely independent — eight toolchains reading the same
# read-only fixtures — so there is nothing to serialise. Sequentially the run is
# the sum of eight compilers; in parallel it costs about the slowest one.
#
#   ./sdks/run-all.sh            # all eight
#   ./sdks/run-all.sh go rust    # a subset
#
# Exits non-zero if any language fails, and prints the tail of a failing log
# only for the languages that failed, so a green run stays one screen.
#
# CI runs this same script, one language per matrix leg — the command a leg
# executes must have exactly one definition, or the assertions added here
# protect local runs only. That already happened: the workflow's own copy of
# these commands drifted from this file in three places before the two were
# merged. Anything CI wants and a local run does not is an environment switch
# below, never a second command list.
set -uo pipefail

cd "$(dirname "$0")/.."
ROOT="$(pwd)"

# The swift leg's thread sanitizer, on in CI and off locally. It is the only
# flag that legitimately differs: the concurrency case asserts a subscription
# count, so a lock dropped on a path it does not drive passes without TSan —
# and a TSan build roughly triples the slowest leg, which CI has a 30-minute
# budget for and a developer's `run-all.sh` should not have to wait on.
#
# A switch rather than an omission, so `PASS swift` says which one ran.
SWIFT_TSAN_FLAG=""
if [ "${SDK_TEST_TSAN:-0}" = "1" ]; then
    SWIFT_TSAN_FLAG="--sanitize=thread"
fi

# A Homebrew JDK is not on the default PATH, and Kotlin needs it too.
if [ -d /opt/homebrew/opt/openjdk/bin ]; then
    export PATH="/opt/homebrew/opt/openjdk/bin:$PATH"
fi

ALL=(python go ruby rust swift java kotlin dart)

# ALL is hardcoded here, again in `lint-all.sh`, again in `generated-check.sh`, and a
# fourth time as the CI matrix in `.github/workflows/test.yml` — so a ninth SDK missed
# in any one of them is silently never checked by that gate. This is the gate that
# actually RUNS the conformance suites, and the full-suite command `CLAUDE.md`
# documents, so a missing port here means eight PASS lines and a ninth port nobody
# ever ran. Reconcile against what is on disk, the only copy that cannot be forgotten.
#
# Everything under sdks/ is a port unless it is listed here. An explicit ignore list
# rather than a marker-file heuristic: a marker SKIPS what it does not match, so a new
# port that forgot the marker is absent from both this list and ALL — no drift,
# silently never run. This way a directory that is not a port costs one deliberate
# line, and anything else fails loudly.
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
    printf 'sdks/run-all.sh ALL and sdks/ disagree (left column: listed but absent; right: present but unlisted):\n%s\n' "$sdk_drift" >&2
    printf 'Update ALL here, ALL in sdks/lint-all.sh and sdks/generated-check.sh, and the sdk-conformance matrix in .github/workflows/test.yml.\n' >&2
    exit 2
fi

LANGS=("$@")
if [ ${#LANGS[@]} -eq 0 ]; then
    LANGS=("${ALL[@]}")
fi

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

run_suite() {
    case "$1" in
        python) (cd "$ROOT/sdks/python" && python3 -m unittest discover -s tests -t .) ;;
        # -count=1 disables the test cache. Every input this suite asserts against
        # — protocol/fixtures/*.json and protocol/conformance-cases.json — lives
        # outside the Go module, so the cache cannot see it change and happily
        # replays a PASS recorded before the fixture or the manifest was edited.
        # That is a gate reporting green without running, which is the one failure
        # mode worse than a slow suite.
        # -v so the per-test lines exist for count_cases to count; CI's leg
        # already passes it. The failure dump below leads with the FAIL lines
        # rather than the tail, because a verbose log's tail is its last test
        # and not its first failure.
        go) (cd "$ROOT/sdks/go" && go test ./... -race -count=1 -v) ;;
        ruby) (cd "$ROOT/sdks/ruby" && ruby -Ilib -e 'Dir["test/test_*.rb"].each { |f| require File.expand_path(f) }') ;;
        rust) (cd "$ROOT/sdks/rust" && cargo test) ;;
        # Unquoted on purpose: empty means "no flag", not an empty argument.
        swift) (cd "$ROOT/sdks/swift" && swift test $SWIFT_TSAN_FLAG) ;;
        java) (cd "$ROOT/sdks/java" && bash build.sh) ;;
        kotlin) (cd "$ROOT/sdks/kotlin" && bash build.sh) ;;
        # `pub get` first, because `dart run` needs .dart_tool/package_config.json
        # and that directory is gitignored. --offline, because this package
        # declares no dependencies: the resolve is local and must never be able to
        # turn a conformance run into a network call.
        dart) (cd "$ROOT/sdks/dart" && dart pub get --offline >/dev/null && dart run test/conformance.dart) ;;
        *)
            echo "unknown language: $1" >&2
            return 2
            ;;
    esac
}

# How many cases a leg actually executed, read out of its own summary line.
#
# This exists because exit 0 is evidence of nothing on its own. Six of these
# eight test tools exit 0 having collected NO tests at all — `unittest discover`
# finding no matching module, an empty `test/test_*.rb` glob, a Go package with
# no `_test.go`, `cargo test` and `swift test` with nothing to run — and a suite
# that ran none of its cases then looks exactly like one that ran all of them.
# The dart leg proved the sharper version of the same thing: it silently
# abandoned `main()` at case 16 of 69, printed nothing, and reported PASS.
#
# Fail-closed on purpose. A leg whose summary cannot be READ counts as zero and
# fails, so a runner change that alters the summary format turns this red rather
# than quietly reverting it to an exit-code-only check.
count_cases() {
    local lang="$1" log="$2"

    case "$lang" in
        python) sed -n 's/^Ran \([0-9][0-9]*\) test.*/\1/p' "$log" | tail -1 ;;
        go) grep -c '^=== RUN' "$log" ;;
        ruby) sed -n 's/^\([0-9][0-9]*\) runs,.*/\1/p' "$log" | tail -1 ;;
        # One `test result:` line per test binary, so they sum.
        rust) sed -n 's/^test result: ok\. \([0-9][0-9]*\) passed.*/\1/p' "$log" | awk '{ total += $1 } END { print total + 0 }' ;;
        # XCTest prints one line per suite plus an "All tests" total; the largest
        # is that total. swift-testing's own "0 tests" line carries no "Executed".
        swift) sed -n 's/.*Executed \([0-9][0-9]*\) test.*/\1/p' "$log" | sort -rn | head -1 ;;
        # These two count assertions rather than cases — their own summary, kept
        # as-is rather than reshaped to match the others.
        java | kotlin) sed -n 's/^OK .* \([0-9][0-9]*\) assertions.*/\1/p' "$log" | tail -1 ;;
        dart) sed -n 's/^PASS  *\([0-9][0-9]*\) cases.*/\1/p' "$log" | tail -1 ;;
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
    cases="$(count_cases "$lang" "$WORK/$lang.log" 2>/dev/null)"

    # A flag that is on in one environment and off in another has to say so on
    # the line a green run prints, or "did TSan actually run in CI" is only
    # answerable by reading the workflow — which is the drift this file exists
    # to remove.
    note=""
    if [ "$lang" = swift ] && [ -n "$SWIFT_TSAN_FLAG" ]; then
        note=" [$SWIFT_TSAN_FLAG]"
    fi

    if ! [ "${cases:-0}" -gt 0 ] 2>/dev/null; then
        cases=0
    fi

    if [ "$status" -ne 0 ]; then
        printf 'FAIL  %s%s (exit %s, %s cases)\n' "$lang" "$note" "$status" "$cases"
        : >"$WORK/$lang.failed"
        failed=1
    elif [ "$cases" -eq 0 ]; then
        printf 'FAIL  %s (exit 0 but no executed cases in its summary — a suite that ran nothing must not read as one that passed)\n' "$lang"
        : >"$WORK/$lang.failed"
        failed=1
    else
        printf 'PASS  %s%s (%s cases)\n' "$lang" "$note" "$cases"
    fi
done

if [ "$failed" -ne 0 ]; then
    for lang in "${LANGS[@]}"; do
        # The sentinel, not the exit status: a leg that exited 0 having executed
        # nothing failed too, and its log is exactly what you need to see.
        if [ -e "$WORK/$lang.failed" ]; then
            printf '\n===== %s =====\n' "$lang"
            # The FAIL lines first: a verbose leg's tail is its LAST test, which
            # is rarely the one that broke.
            grep -E '^ *--- FAIL|^FAIL|^panic:|^FAIL  ' "$WORK/$lang.log" | head -20
            tail -25 "$WORK/$lang.log"
        fi
    done
fi

exit "$failed"
