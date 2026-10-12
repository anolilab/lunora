#!/usr/bin/env bash
# Writes one Worker's secrets as a JSON file for `wrangler deploy --secrets-file`.
#
# Each argument is `WORKER_NAME=SOURCE`, read from the environment: the file gets
# `WORKER_NAME` with the value of the `SOURCE` variable. Empty sources are left out,
# so an optional secret that was never set stays unset on the Worker.
#
#   bash scripts/worker-secrets.sh out.json AUTH_SECRET=AUTH_SECRET GITHUB_WEBHOOK_SECRET=CLOUD_GITHUB_WEBHOOK_SECRET
#
# The values are passed through `jq --arg`, never as command arguments, so they stay
# out of the process list and the workflow log.
set -euo pipefail

out="$1"
shift

args=()
for pair in "$@"; do
    name="${pair%%=*}"
    source="${pair#*=}"
    value="${!source-}"

    if [ -n "${value}" ]; then
        args+=(--arg "${name}" "${value}")
    fi
done

# shellcheck disable=SC2016 # jq program, not a shell expansion
jq -n '$ARGS.named' "${args[@]+"${args[@]}"}" > "${out}"
chmod 600 "${out}"
