#!/usr/bin/env bash
#
# The `workerd` vitest projects — the gate `pnpm run test` cannot cover.
#
# Every workspace listed here also has its own CI job ("Workerd integration (<dir>)"),
# and those jobs are the only ones that run these suites. Locally the suites are
# gated behind LUNORA_WORKERD_TESTS=1 and so absent from `pnpm run test`, for two
# reasons that are not going away:
#
#   - Coverage cannot be on. The v8 provider collects through `node:inspector`,
#     which workerd does not implement, and the suites HANG rather than fail with
#     it enabled. `pnpm run test:coverage` — the target CI's main leg runs — can
#     therefore never include them.
#   - Some environments cannot boot workerd at all. `@cloudflare/vitest-plugin`
#     needs unrestricted localhost-loopback between workerd and the test host;
#     sandboxed CI images and agent harnesses block it.
#
# So a full local sweep can be green while a workerd suite is red — which is
# exactly how a `_creationTime` probe shipped inverted: `node:sqlite` raises on a
# bare double-quoted column that resolves to nothing, workerd's SQLite silently
# reads it as a string literal, and the node suites could not see the difference.
# Run this before pushing anything that touches SQL, storage, or a Durable Object.
#
# Workspaces are discovered, never listed — the same `name: "workerd"` predicate the
# CI drift guard in .github/workflows/test.yml asserts the job matrix against, so
# this script and that matrix are the same set by construction. Packages and apps
# both (`apps/cloud` holds the BoxSessionDO suite); each is addressed by its
# directory, since an app's vis project and package names differ from it.
#
# Suites run ONE AT A TIME on purpose: every package's vitest in parallel fails a
# different arbitrary set each run (resource contention, not real failures), which
# is the same reason `pnpm -r run test` is banned repo-wide.
#
# Exit codes:
#   0  — every suite passed
#   1  — at least one suite failed
#
# Usage:
#   pnpm run test:workerd                              # every workspace declaring a workerd project
#   pnpm run test:workerd packages/auth apps/cloud     # just these
set -euo pipefail

cd "$(dirname "$0")/.."

if [ "$#" -gt 0 ]; then
    workspaces=("$@")
else
    # `grep -l` exits 1 when nothing matches, and under `set -e` + `pipefail` that
    # status propagates out of the assignment and kills the script BEFORE the
    # diagnostic below — so the "nothing to run" branch was unreachable and the
    # failure was a bare exit 1 with no output. Capture the status instead, and keep
    # 1 ("no match", explained below) distinct from 2 (a real grep failure, e.g. an
    # unreadable tree), which must not be reported as an empty repo.
    set +e
    discovered="$(grep -l 'name: "workerd"' packages/*/vitest.config.ts apps/*/vitest.config.ts | sed 's|/vitest.config.ts||' | sort)"
    status=$?
    set -e

    if [ "$status" -gt 1 ]; then
        echo "Could not scan packages/*/vitest.config.ts and apps/*/vitest.config.ts (grep exited ${status})." >&2
        exit 1
    fi

    # shellcheck disable=SC2206 # deliberate word-split: the predicate yields one workspace directory per line
    workspaces=($discovered)
fi

if [ "${#workspaces[@]}" -eq 0 ]; then
    echo "No workspace declares a \`workerd\` vitest project — nothing to run." >&2
    exit 1
fi

echo "==> Building packages (the suites import dist, not src)"
pnpm run build:packages

failed=()

for workspace in "${workspaces[@]}"; do
    echo
    echo "==> ${workspace} (workerd)"

    if LUNORA_WORKERD_TESTS=1 pnpm --filter "./${workspace}" run test --project workerd; then
        echo "PASS  ${workspace}"
    else
        echo "FAIL  ${workspace}"
        failed+=("${workspace}")
    fi
done

echo
echo "================================================================"

if [ "${#failed[@]}" -gt 0 ]; then
    echo "${#failed[@]} of ${#workspaces[@]} workerd suites FAILED: ${failed[*]}"
    exit 1
fi

echo "All ${#workspaces[@]} workerd suites passed."
