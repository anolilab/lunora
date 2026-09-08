#!/usr/bin/env bash
#
# The `workerd` vitest projects — the gate `pnpm run test` cannot cover.
#
# Every package listed here also has its own CI job ("Workerd integration (<pkg>)"),
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
# Packages are discovered, never listed — the same `name: "workerd"` predicate the
# CI drift guard in .github/workflows/test.yml asserts the job matrix against, so
# this script and that matrix are the same set by construction.
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
#   pnpm run test:workerd              # all packages declaring a workerd project
#   pnpm run test:workerd auth do      # just these
set -euo pipefail

cd "$(dirname "$0")/.."

if [ "$#" -gt 0 ]; then
    packages=("$@")
else
    # shellcheck disable=SC2207 # deliberate word-split: the predicate yields one bare package name per line
    packages=($(grep -l 'name: "workerd"' packages/*/vitest.config.ts | sed 's|packages/||; s|/vitest.config.ts||' | sort))
fi

if [ "${#packages[@]}" -eq 0 ]; then
    echo "No package declares a \`workerd\` vitest project — nothing to run." >&2
    exit 1
fi

echo "==> Building packages (the suites import dist, not src)"
pnpm run build:packages

failed=()

for package in "${packages[@]}"; do
    echo
    echo "==> @lunora/${package} (workerd)"

    if LUNORA_WORKERD_TESTS=1 pnpm --filter "@lunora/${package}" run test --project workerd; then
        echo "PASS  @lunora/${package}"
    else
        echo "FAIL  @lunora/${package}"
        failed+=("${package}")
    fi
done

echo
echo "================================================================"

if [ "${#failed[@]}" -gt 0 ]; then
    echo "${#failed[@]} of ${#packages[@]} workerd suites FAILED: ${failed[*]}"
    exit 1
fi

echo "All ${#packages[@]} workerd suites passed."
