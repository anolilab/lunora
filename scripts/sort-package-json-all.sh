#!/usr/bin/env bash
#
# `vis sort-package-json` over EVERY tracked manifest, not just the workspaces.
#
# The sorter takes its file set from `pnpm-workspace.yaml` and resolves it from
# the repo root whatever the cwd, so it reads 76 of the 90 tracked
# `package.json` files. The 14 it skips are `templates/*` and `.deepsec` — and
# `templates/*` is exactly where drift is invisible, because the CI path filter
# matched `**/package.json`, so a template-only PR ran the job, had its manifest
# never opened, and got a green check on the file it changed.
#
# `templates/*` cannot simply join the workspace: they are whole-project starters
# that `lunora init` fetches, and a workspace link would rewrite the `@lunora/*`
# ranges they ship. So this widens the file set for the length of one run and
# puts `pnpm-workspace.yaml` back, restoring it on any exit path.
#
# Using the repo's own sorter rather than adding a second one is the point.
# `sort-package-json` from npm reports all four of
# `packages/{do,client,runtime,server}/package.json` as unsorted after vis has
# sorted them: the two disagree on key order, so adding it would install a rival
# convention and churn every manifest it touched.
#
# Usage:
#   scripts/sort-package-json-all.sh --check   # exit 1 when anything is unsorted
#   scripts/sort-package-json-all.sh           # sort in place
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORKSPACE="${REPO_ROOT}/pnpm-workspace.yaml"
BACKUP="$(mktemp)"

cp "${WORKSPACE}" "${BACKUP}"

# Restore on success, failure and interrupt alike: leaving the widened workspace
# behind would make the next `pnpm install` try to resolve the templates' deps.
restore() {
    cp "${BACKUP}" "${WORKSPACE}"
    rm -f "${BACKUP}"
}
trap restore EXIT INT TERM

# Append the extra globs to the `packages:` list. Anchored on the last workspace
# entry rather than a line number so a reordering of that list cannot silently
# turn this into a no-op.
if ! grep -q '^  - "tests/\*"$' "${WORKSPACE}"; then
    echo "pnpm-workspace.yaml no longer lists 'tests/*' — update the anchor in $(basename "${BASH_SOURCE[0]}")." >&2
    exit 2
fi

awk '{ print } /^  - "tests\/\*"$/ { print "  - \"templates/*\"" }' "${BACKUP}" > "${WORKSPACE}"

# `pnpm exec` would run a deps-status check first and fail on the templates'
# unresolvable workspace deps, so call the binary.
npm_config_verify_deps_before_run=false "${REPO_ROOT}/node_modules/.bin/vis" sort-package-json "$@"
