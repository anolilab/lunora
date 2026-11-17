#!/usr/bin/env bash
# Writes one Worker's secrets as a JSON file for `wrangler deploy --secrets-file`.
#
# Each argument is `WORKER_NAME=SOURCE`, read from the environment: the file gets
# `WORKER_NAME` with the value of the `SOURCE` variable. Empty sources are left out,
# so an optional secret that was never set stays unset on the Worker.
#
#   bash scripts/worker-secrets.sh out.json AUTH_SECRET=AUTH_SECRET GITHUB_WEBHOOK_SECRET=CLOUD_GITHUB_WEBHOOK_SECRET
#
# jq reads the values from its environment (`$ENV`); only the variable names reach its
# command line, so the values stay out of the process list and the workflow log.
set -euo pipefail

out="$1"
shift

# shellcheck disable=SC2016 # jq program, not a shell expansion
jq -n '
    [$ARGS.positional[] | capture("^(?<name>[^=]+)=(?<source>.*)$") | { key: .name, value: ($ENV[.source] // "") } | select(.value != "")]
    | from_entries
' --args "$@" > "${out}"
chmod 600 "${out}"
