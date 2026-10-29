#!/usr/bin/env bash
#
# Live smoke test for @lunora/browser against a real Browser Run binding.
#
# Deploys packages/browser/smoke (a Worker that serves its own attacker-like
# fixtures) with `wrangler deploy`, fetches its /report, prints it, and exits
# non-zero when any check failed. Needs a Workers Paid account with Browser Run
# and `wrangler login` (or CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID). See
# packages/browser/smoke/README.md.
#
# Not run by CI: it deploys to a real account. Tear down with
#   pnpm --dir packages/browser exec wrangler delete --config smoke/wrangler.jsonc
#
# Exit codes:
#   0  — every check passed
#   1  — a check failed, or the deploy / report request failed
set -euo pipefail

cd "$(dirname "$0")/.."

deploy_log="$(mktemp)"
trap 'rm -f "$deploy_log"' EXIT

echo "==> Deploying the smoke Worker"
pnpm --dir packages/browser exec wrangler deploy --config smoke/wrangler.jsonc 2>&1 | tee "$deploy_log"

url="$(grep -Eo 'https://[A-Za-z0-9.-]+\.workers\.dev' "$deploy_log" | head -n 1 || true)"

if [ -z "$url" ]; then
    echo "Could not find the workers.dev URL in wrangler's output." >&2
    exit 1
fi

echo
echo "==> Running the checks: ${url}/report"
report="$(curl --fail --silent --show-error --max-time 300 "${url}/report")"

echo "$report"

node -e '
const report = JSON.parse(process.argv[1]);
for (const check of report.checks) {
    console.log(`${check.pass ? "PASS" : "FAIL"}  ${check.name}: ${check.detail}`);
}
process.exit(report.ok ? 0 : 1);
' "$report"
