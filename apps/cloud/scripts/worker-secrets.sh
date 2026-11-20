#!/usr/bin/env bash
# Writes one Worker's secrets as a JSON file for `wrangler deploy --secrets-file`.
#
# Each argument is `WORKER_NAME=SOURCE`, read from the environment: the file gets
# `WORKER_NAME` with the value of the `SOURCE` variable. Empty sources are left out,
# so an optional secret that was never set stays unset on the Worker. A pair
# prefixed with `!` is required: an empty source fails the script instead, since a
# Worker that cannot start without it would otherwise deploy green and fail every
# request.
#
#   bash scripts/worker-secrets.sh out.json '!AUTH_SECRET=AUTH_SECRET' GITHUB_WEBHOOK_SECRET=CLOUD_GITHUB_WEBHOOK_SECRET
#
# jq reads the values from its environment (`$ENV`); only the variable names reach its
# command line, so the values stay out of the process list and the workflow log.
set -euo pipefail

out="$1"
shift

pairs=()
missing=()

for pair in "$@"; do
    if [[ "${pair}" == '!'* ]]; then
        pair="${pair#!}"
        source_name="${pair#*=}"

        if [[ -z "${!source_name:-}" ]]; then
            missing+=("${pair%%=*} (from ${source_name})")
        fi
    fi

    pairs+=("${pair}")
done

if [[ ${#missing[@]} -gt 0 ]]; then
    printf 'worker-secrets: required secret is empty or unset: %s\n' "${missing[@]}" >&2
    exit 1
fi

# shellcheck disable=SC2016 # jq program, not a shell expansion
jq -n '
    [$ARGS.positional[] | capture("^(?<name>[^=]+)=(?<source>.*)$") | { key: .name, value: ($ENV[.source] // "") } | select(.value != "")]
    | from_entries
' --args "${pairs[@]}" > "${out}"
chmod 600 "${out}"
