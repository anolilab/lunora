#!/usr/bin/env bash
# Installs, upgrades or removes lunora-hostd on a Debian 12+ or Ubuntu 22.04+
# server (plan 458 W7) — the releases whose OpenSSL 3 verifies the release
# signature. Published with every hostd-v* GitHub Release; the release
# notes give its SHA-256.
#
#   curl -fsSLO https://github.com/anolilab/lunora/releases/download/hostd-v<version>/install.sh
#   sudo bash install.sh --control-plane https://<cloud> --bucket <name> [--endpoint <url>] --version <version>
#
# It asks for the enrolment token (the studio shows it) and the bucket's access
# key, without echoing what is typed. For automation, --token-file and
# --credentials-file name root-only files instead.
#
# Re-running it upgrades the box in place to the newest release on its channel
# (stable, or pre-release for a box on one), or to --version.
# `--uninstall` removes hostd, its users, unit and files, and never the bucket.
#
# Trust: this script pins the Ed25519 release keys (TRUSTED RELEASE KEYS below,
# the same set compiled into lunora-hostd) and checks each key's fingerprint.
# It verifies the release manifest's signature with OpenSSL before trusting any
# hash in it (protocol/hostd/README.md §8) and checks lunora-hostd against the
# manifest's SHA-256 and size. That binary then verifies the manifest again with
# its own strict verifier and installs the release (`install-release`), checking
# celld and Caddy against it, exactly as an `upgrade` job does.
#
# Secrets — the enrolment token and the bucket credentials — never reach a
# command line (shell history, `ps`, sudo's log): they are typed at a hidden
# prompt, read from a file only root can read, or taken from the environment,
# handed to `lunora-hostd enrol` through its environment alone, and never
# printed. Nothing else this script runs inherits them.
set -euo pipefail

REPOSITORY="anolilab/lunora"
INSTALL_DIR="/opt/lunora-hostd"
CONFIG_DIR="/etc/lunora-hostd"
DATA_DIR="/var/lib/lunora-hostd"
UNIT_PATH="/etc/systemd/system/lunora-hostd.service"
HOSTD_USER="lunora-hostd"
FLEET_USER="lunora-fleet"
EDGE_USER="lunora-edge"
NFT_TABLE="lunora_hostd"
OS_RELEASE="/etc/os-release"
# A "2 GB" server reports a little under 2048 MiB.
MIN_MEMORY_MIB=1900

# BEGIN TRUSTED RELEASE KEYS
# The release-signing public keys, by key id: the same set as
# HOSTD_TRUSTED_RELEASE_KEYS in apps/hostd/src/trusted-release-keys.ts (a test
# keeps them equal; scripts/release-public-key.mjs prints both entries).
trusted_key() {
    case "$1" in
        ed25519-placeholder)
            printf '%s\n' 'PLACEHOLDER-NOT-A-KEY: replace with the output of apps/hostd/scripts/release-public-key.mjs'
            ;;
        *)
            return 1
            ;;
    esac
}
# END TRUSTED RELEASE KEYS

say() { printf 'lunora-hostd install: %s\n' "$*" >&2; }
die() {
    say "error: $*"
    exit 1
}

usage() {
    cat >&2 <<'USAGE'
Usage: install.sh [options]

Install or upgrade (run it again):
  --control-plane <origin>   Lunora Cloud's origin (required to enrol)
  --bucket <name|s3://name>  your bucket (required to enrol)
  --endpoint <url>           S3-compatible endpoint (R2, Tigris, MinIO...)
  --region <region>          bucket region
  --ipv4 <address>           public address (detected when omitted)
  --ipv6 <address>
  --single-trust             run fleets even when isolation is incomplete
  --skip-bucket-check        do not probe the bucket with celld first
  --force                    enrol again, as a new box
  --token-file <path>        read the enrolment token from this file (root's, 0600)
                             instead of asking for it
  --credentials-file <path>  read AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY
                             (/ AWS_SESSION_TOKEN) lines from this file (root's,
                             0600) instead of asking for them
  --version <version>        install this release instead of the newest
  --prerelease               without --version: the newest pre-release too
                             (a box on a pre-release stays on pre-releases)
  --allow-downgrade          install it even when it is older than the installed one

Remove:
  --uninstall                remove hostd, its users and files (never the bucket)

Enrolling asks for the token and the bucket's access key at a hidden prompt.
LUNORA_HOSTD_ENROL_TOKEN and AWS_* in the environment are used when set; never
put a secret on the command line.
USAGE
}

VERSION=""
# Secrets, taken out of the environment at once so nothing this script runs inherits them;
# only `lunora-hostd enrol` gets them back (enrol below).
TOKEN="${LUNORA_HOSTD_ENROL_TOKEN:-}"
BUCKET_KEY_ID="${AWS_ACCESS_KEY_ID:-}"
BUCKET_SECRET="${AWS_SECRET_ACCESS_KEY:-}"
BUCKET_SESSION="${AWS_SESSION_TOKEN:-}"
unset LUNORA_HOSTD_ENROL_TOKEN AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN
TOKEN_FILE=""
CREDENTIALS_FILE=""
UNINSTALL=0
FORCE=0
ALLOW_DOWNGRADE=0
PRERELEASE=0
ENROL_ARGS=()
PLATFORM=""
RELEASE_ID=""
TAG=""

need_value() {
    if [ "$#" -lt 2 ] || [ -z "$2" ]; then
        die "$1 needs a value"
    fi
}

parse_args() {
    while [ "$#" -gt 0 ]; do
        case "$1" in
            --control-plane | --bucket | --endpoint | --region | --ipv4 | --ipv6)
                need_value "$@"
                ENROL_ARGS+=("$1" "$2")
                shift 2
                ;;
            --single-trust | --skip-bucket-check)
                ENROL_ARGS+=("$1")
                shift
                ;;
            --force)
                FORCE=1
                ENROL_ARGS+=("$1")
                shift
                ;;
            --token-file)
                need_value "$@"
                TOKEN_FILE="$2"
                shift 2
                ;;
            --credentials-file)
                need_value "$@"
                CREDENTIALS_FILE="$2"
                shift 2
                ;;
            --token)
                die "--token would leave the token in your shell history: paste it when asked, or use --token-file"
                ;;
            --version)
                need_value "$@"
                VERSION="${2#v}"
                shift 2
                ;;
            --allow-downgrade)
                ALLOW_DOWNGRADE=1
                shift
                ;;
            --prerelease)
                PRERELEASE=1
                shift
                ;;
            --uninstall)
                UNINSTALL=1
                shift
                ;;
            -h | --help)
                usage
                exit 0
                ;;
            *)
                usage
                die "unknown option: $1"
                ;;
        esac
    done
}

uninstall() {
    say "removing lunora-hostd (the bucket and everything in it are left alone)"

    if systemctl list-unit-files lunora-hostd.service > /dev/null 2>&1; then
        systemctl disable --now lunora-hostd.service > /dev/null 2>&1 || true
    fi

    rm -f "${UNIT_PATH}"
    systemctl daemon-reload

    if command -v nft > /dev/null 2>&1; then
        nft delete table inet "${NFT_TABLE}" > /dev/null 2>&1 || true
    fi

    rm -rf -- "${INSTALL_DIR}" "${DATA_DIR}" "${CONFIG_DIR}"

    for user in "${HOSTD_USER}" "${FLEET_USER}" "${EDGE_USER}"; do
        if id -u "${user}" > /dev/null 2>&1; then
            userdel "${user}"
        fi
    done

    say "done. Revoke the box in the Lunora Cloud studio; its fleets' data stays in your bucket under fleets/."
}

# --- The machine -------------------------------------------------------------

# Debian 12+ or Ubuntu 22.04+ (or a derivative of either): the first releases whose
# OpenSSL (3.x) can verify an Ed25519 signature over raw bytes (pkeyutl -rawin).
check_os_release() {
    local id="" id_like="" version=""

    if [ -r "${OS_RELEASE}" ]; then
        # shellcheck disable=SC1090 # the running system's os-release, not a file in this repository
        id="$(. "${OS_RELEASE}" && printf '%s' "${ID:-}")"
        # shellcheck disable=SC1090
        id_like="$(. "${OS_RELEASE}" && printf '%s' "${ID_LIKE:-}")"
        # shellcheck disable=SC1090
        version="$(. "${OS_RELEASE}" && printf '%s' "${VERSION_ID:-}")"
    fi

    case " ${id} ${id_like} " in
        *" debian "* | *" ubuntu "*) ;;
        *) die "this installer supports Debian 12+ and Ubuntu 22.04+ (found '${id:-unknown}')" ;;
    esac

    # Derivatives (ID_LIKE) number their releases their own way: check_openssl decides for them.
    case "${id}" in
        # Testing and sid carry no VERSION_ID, and are newer than any stable release.
        debian) [ -z "${version}" ] || [ "${version%%.*}" -ge 12 ] 2> /dev/null || die "this installer supports Debian 12 (bookworm) and later, not Debian ${version:-unknown}: older releases ship OpenSSL 1.1, which cannot verify the release signature" ;;
        ubuntu) [ "${version%%.*}" -ge 22 ] 2> /dev/null || die "this installer supports Ubuntu 22.04 and later, not Ubuntu ${version:-unknown}: older releases ship OpenSSL 1.1, which cannot verify the release signature" ;;
        *) ;;
    esac
}

# The release signature is checked with `openssl pkeyutl -verify -rawin`, which OpenSSL
# 1.1 lacks: it would fail as "signature does not verify". Say what is wrong instead.
check_openssl() {
    local version

    version="$(openssl version 2> /dev/null | awk '{ print $1 " " $2 }')"

    case "${version}" in
        "OpenSSL "[3-9].* | "OpenSSL "[1-9][0-9].*) ;;
        *) die "install.sh verifies the release signature with OpenSSL 3 or later (Debian 12+, Ubuntu 22.04+); this machine has ${version:-no openssl}" ;;
    esac
}

check_machine() {
    check_os_release

    case "$(uname -m)" in
        x86_64 | amd64) PLATFORM="linux-x64" ;;
        aarch64 | arm64) PLATFORM="linux-arm64" ;;
        *) die "unsupported architecture $(uname -m): lunora-hostd runs on amd64 and arm64" ;;
    esac

    local memory_kib
    memory_kib="$(awk '/^MemTotal:/ { print $2 }' /proc/meminfo)"

    if [ "$((memory_kib / 1024))" -lt "${MIN_MEMORY_MIB}" ]; then
        die "this server has $((memory_kib / 1024)) MiB of memory; lunora-hostd needs 2 GB"
    fi

    [ -d /run/systemd/system ] || die "systemd is not running; lunora-hostd runs as a systemd service"
}

install_packages() {
    local missing=()

    command -v curl > /dev/null 2>&1 || missing+=(curl ca-certificates)
    command -v jq > /dev/null 2>&1 || missing+=(jq)
    command -v openssl > /dev/null 2>&1 || missing+=(openssl)
    command -v nft > /dev/null 2>&1 || missing+=(nftables)
    command -v setpriv > /dev/null 2>&1 || missing+=(util-linux)
    command -v gzip > /dev/null 2>&1 || missing+=(gzip)

    if [ "${#missing[@]}" -gt 0 ]; then
        say "installing ${missing[*]}"
        DEBIAN_FRONTEND=noninteractive apt-get update -qq
        DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends "${missing[@]}" > /dev/null
    fi
}

create_users() {
    if ! id -u "${HOSTD_USER}" > /dev/null 2>&1; then
        useradd --system --user-group --home-dir "${DATA_DIR}" --no-create-home --shell /usr/sbin/nologin "${HOSTD_USER}"
    fi

    # Fleets, and Caddy (which parses untrusted HTTP), each as a user that cannot read the box key.
    for user in "${FLEET_USER}" "${EDGE_USER}"; do
        if ! id -u "${user}" > /dev/null 2>&1; then
            useradd --system --user-group --home-dir /nonexistent --no-create-home --shell /usr/sbin/nologin "${user}"
        fi
    done
}

create_directories() {
    # The key and the bucket credentials: lunora-hostd's alone.
    install -d -o "${HOSTD_USER}" -g "${HOSTD_USER}" -m 0700 "${CONFIG_DIR}"
    # The fleet group may pass through (to its working directory), and Caddy's user (to
    # its own directories), never list. Nothing below is open to other users.
    install -d -o "${HOSTD_USER}" -g "${FLEET_USER}" -m 0711 "${DATA_DIR}"
    # Caddy's (apps/hostd/README.md, "Files"), laid out here because the daemon may not: the
    # unit's RestrictSUIDSGID=yes forbids it the set-group-ID bits, and it only checks them.
    # caddy/ is lunora-hostd's (caddy.json takes the edge group), state/ is Caddy's own, and
    # log/ is Caddy's (the access log takes lunora-hostd's group). A link here is refused:
    # lunora-hostd owns the data directory, and root must not follow one it planted.
    local dir
    for dir in caddy caddy/state caddy/log; do
        if [ -L "${DATA_DIR}/${dir}" ] || { [ -e "${DATA_DIR}/${dir}" ] && [ ! -d "${DATA_DIR}/${dir}" ]; }; then
            die "${DATA_DIR}/${dir} is not a directory; remove it and run install.sh again"
        fi
    done
    install -d -o "${HOSTD_USER}" -g "${EDGE_USER}" -m 2750 "${DATA_DIR}/caddy"
    # 00700, not 0700: a directory made in caddy/ inherits its set-group-ID bit, and install
    # (like chmod) keeps that bit on a directory unless the mode clears it explicitly.
    install -d -o "${EDGE_USER}" -g "${EDGE_USER}" -m 00700 "${DATA_DIR}/caddy/state"
    install -d -o "${EDGE_USER}" -g "${HOSTD_USER}" -m 2750 "${DATA_DIR}/caddy/log"
    # Releases: lunora-hostd writes them (upgrade), everyone may execute them.
    install -d -o "${HOSTD_USER}" -g "${HOSTD_USER}" -m 0755 "${INSTALL_DIR}"
}

# --- The release -------------------------------------------------------------

WORK=""
cleanup() {
    if [ -n "${WORK}" ]; then
        rm -rf -- "${WORK}"
    fi
}
trap cleanup EXIT

# fetch <url> <out> [curl options]: HTTPS only, also across redirects (GitHub serves assets from its CDN).
fetch() {
    curl -fsSL --proto '=https' --proto-redir '=https' --tlsv1.2 --retry 3 "${@:3}" -o "$2" "$1"
}

# Run a command as lunora-hostd, from its data directory, with only the environment exported to it.
as_hostd() {
    (
        cd "${DATA_DIR}"
        exec setpriv --reuid="${HOSTD_USER}" --regid="${HOSTD_USER}" --init-groups -- "$@"
    )
}

# The release to install: --version, else the newest on the box's channel, as the
# release workflow records it in latest.json on the GitHub Release hostd-latest
# (apps/hostd/scripts/update-latest-pointer.mjs). The repository's release list
# is no help: it holds a release per package per version, and hostd's fall off
# its first page at once. The pointer is only a hint — the manifest it leads to
# is verified like any other, and lunora-hostd refuses a release older than the
# installed one.
resolve_tag() {
    local channel="stable" installed=""

    if [ -z "${VERSION}" ]; then
        # A box on a pre-release stays on pre-releases (it gets a newer stable one too).
        installed="$(jq -r '.manifest.hostd.version // empty' "${INSTALL_DIR}/current/manifest.json" 2> /dev/null || true)"

        if [ "${PRERELEASE}" -eq 1 ] || [[ "${installed%%+*}" == *-* ]]; then
            channel="prerelease"
        fi

        fetch "https://github.com/${REPOSITORY}/releases/download/hostd-latest/latest.json" "${WORK}/latest.json" ||
            die "could not read which hostd release is the newest; pass --version <version>"
        VERSION="$(jq -r --arg channel "${channel}" '.[$channel] // empty' "${WORK}/latest.json")"

        if [ -z "${VERSION}" ]; then
            die "no ${channel} hostd release is published yet; pass --version <version>$([ "${channel}" = "prerelease" ] || printf ' or --prerelease')"
        fi

        say "the newest ${channel} release is ${VERSION}"
    fi

    [[ "${VERSION}" =~ ^[0-9][A-Za-z0-9_.+~-]{0,63}$ ]] || die "not a release version: ${VERSION}"
    TAG="hostd-v${VERSION}"
}

# Verify manifest.json's Ed25519 signature against a pinned key (§8.2), with OpenSSL.
verify_signature() {
    local manifest="$1" key_id pem fingerprint

    key_id="$(jq -r '.keyId' "${manifest}")"
    [[ "${key_id}" =~ ^[A-Za-z0-9_.-]{1,64}$ ]] || die "the manifest names no valid key id"
    pem="$(trusted_key "${key_id}")" || die "the manifest is signed with ${key_id}, which this installer does not trust"

    case "${pem}" in
        *PLACEHOLDER*) die "no release key is pinned in this installer yet: there is nothing it can verify" ;;
        *) ;;
    esac

    printf '%s\n' "${pem}" > "${WORK}/release-key.pem"
    # The key id is the key's fingerprint: ed25519- and 16 hex digits of SHA-256 over the raw 32-byte key.
    fingerprint="$(openssl pkey -pubin -in "${WORK}/release-key.pem" -outform DER | tail -c 32 | sha256sum | cut -c 1-16)"
    [ "ed25519-${fingerprint}" = "${key_id}" ] || die "the pinned key for ${key_id} does not have that fingerprint"

    { printf 'lunora-hostd-release:v1\n'; jq -cjS '.manifest' "${manifest}"; } > "${WORK}/payload"
    jq -r '.signature' "${manifest}" | tr '_-' '/+' | sed -e 's/$/==/' | base64 -d > "${WORK}/signature"
    openssl pkeyutl -verify -pubin -inkey "${WORK}/release-key.pem" -rawin -in "${WORK}/payload" -sigfile "${WORK}/signature" > /dev/null 2>&1 ||
        die "the release manifest's signature does not verify"
}

# Download one component for this platform as published, no larger than the manifest pins.
# lunora-hostd checks every download against the manifest before it installs anything.
download_component() {
    local component="$1" out="$2" entry url size

    entry="$(jq -c --arg c "${component}" --arg p "${PLATFORM}" '.manifest[$c].artifacts[] | select(.platform == $p)' "${WORK}/manifest.json")"
    [ -n "${entry}" ] || die "release ${RELEASE_ID} ships no ${component} for ${PLATFORM}"
    url="$(jq -r '.url' <<< "${entry}")"
    size="$(jq -r '.size' <<< "${entry}")"
    [[ "${url}" =~ ^https:// && "${size}" =~ ^[0-9]+$ ]] || die "the manifest's ${component} entry is malformed"

    say "downloading ${component} ($((size / 1048576)) MiB)"
    fetch "${url}" "${out}" --max-filesize "${size}"
}

# The one binary this script runs from the release: lunora-hostd, checked against the
# SHA-256 and size of the manifest it has just verified, decompressed when published so.
bootstrap_hostd() {
    local entry sha256 size

    entry="$(jq -c --arg p "${PLATFORM}" '.manifest.hostd.artifacts[] | select(.platform == $p)' "${WORK}/manifest.json")"
    sha256="$(jq -r '.sha256' <<< "${entry}")"
    size="$(jq -r '.size' <<< "${entry}")"
    [[ "${sha256}" =~ ^[0-9a-f]{64}$ ]] || die "the manifest's hostd entry is malformed"
    [ "$(stat -c %s "${WORK}/lunora-hostd")" -eq "${size}" ] || die "lunora-hostd: the download is not the ${size} bytes the manifest pins"
    printf '%s  %s\n' "${sha256}" "${WORK}/lunora-hostd" | sha256sum --check --status || die "lunora-hostd: SHA-256 does not match the manifest"

    if [ "$(jq -r '.compression // empty' <<< "${entry}")" = "gzip" ]; then
        gzip -dc "${WORK}/lunora-hostd" > "${WORK}/bootstrap"
    else
        cp "${WORK}/lunora-hostd" "${WORK}/bootstrap"
    fi

    chmod 0755 "${WORK}/bootstrap"
}

install_release() {
    # Not the temporary directory, which may be mounted noexec, and not the install
    # directory, which lunora-hostd may write: a root-owned directory beside it.
    WORK="$(mktemp -d "${INSTALL_DIR%/*}/.lunora-hostd-install.XXXXXX")"
    chmod 0755 "${WORK}"
    resolve_tag

    local base="https://github.com/${REPOSITORY}/releases/download/${TAG}"

    say "installing ${TAG} for ${PLATFORM}"
    fetch "${base}/manifest.json" "${WORK}/manifest.json"
    verify_signature "${WORK}/manifest.json"
    RELEASE_ID="$(jq -r '.manifest.releaseId' "${WORK}/manifest.json")"
    [[ "${RELEASE_ID}" =~ ^[A-Za-z0-9_-]{1,128}$ ]] || die "the manifest's release id is malformed"

    download_component hostd "${WORK}/lunora-hostd"
    download_component celld "${WORK}/celld"
    download_component caddy "${WORK}/caddy"
    chmod 0644 "${WORK}/lunora-hostd" "${WORK}/celld" "${WORK}/caddy" "${WORK}/manifest.json"
    bootstrap_hostd

    # lunora-hostd's bytes match the manifest this script verified; now its own strict
    # verifier checks the manifest and every download again, and installs the release
    # exactly as an upgrade does — as lunora-hostd, which owns the install directory.
    local downgrade=()

    if [ "${ALLOW_DOWNGRADE}" -eq 1 ]; then
        downgrade=(--allow-downgrade)
    fi

    as_hostd "${WORK}/bootstrap" install-release "${WORK}/manifest.json" --from "${WORK}" \
        --install-dir "${INSTALL_DIR}" --platform "${PLATFORM}" "${downgrade[@]}" > /dev/null ||
        die "lunora-hostd refused the release"
    say "installed ${RELEASE_ID}"
}

# --- Secrets -----------------------------------------------------------------

needs_enrolment() {
    [ ! -f "${CONFIG_DIR}/config.json" ] || [ "${FORCE}" -eq 1 ]
}

# A file holding a secret for automation: a regular file, root's, readable by root alone.
check_secret_file() {
    local path="$1" what="$2"

    if [ ! -f "${path}" ] || [ -L "${path}" ]; then
        die "${what} ${path} is not a regular file"
    fi
    [ "$(stat -c %u "${path}")" = "0" ] || die "${what} ${path} must belong to root"

    case "$(stat -c %a "${path}")" in
        600 | 400) ;;
        *) die "${what} ${path} must be readable by root alone (chmod 600 ${path})" ;;
    esac
}

# Ask on the terminal without echoing what is typed. Only when stdin is a terminal.
ask_secret() {
    local prompt="$1" answer=""

    [ -t 0 ] || return 1
    printf '%s' "${prompt}" >&2
    IFS= read -rs answer || true
    printf '\n' >&2
    printf '%s' "${answer}"
}

# KEY=value lines; only the AWS_* names enrol uses are read, nothing is evaluated.
read_credentials_file() {
    local name value

    check_secret_file "${CREDENTIALS_FILE}" "the credentials file"

    while IFS='=' read -r name value || [ -n "${name}" ]; do
        case "${name}" in
            AWS_ACCESS_KEY_ID) BUCKET_KEY_ID="${value}" ;;
            AWS_SECRET_ACCESS_KEY) BUCKET_SECRET="${value}" ;;
            AWS_SESSION_TOKEN) BUCKET_SESSION="${value}" ;;
            *) ;;
        esac
    done < "${CREDENTIALS_FILE}"
}

# Gather what enrolling needs before anything is downloaded, so a missing token
# fails at once rather than after the release is installed.
read_secrets() {
    needs_enrolment || return 0

    if [ -n "${TOKEN_FILE}" ]; then
        check_secret_file "${TOKEN_FILE}" "the token file"
        IFS= read -r TOKEN < "${TOKEN_FILE}" || true
    fi

    if [ -z "${TOKEN}" ]; then
        TOKEN="$(ask_secret "Enrolment token (the studio shows it; typing is not echoed): ")" || true
    fi

    TOKEN="${TOKEN//[[:space:]]/}"
    [ -n "${TOKEN}" ] || die "no enrolment token: run install.sh in a terminal and paste it when asked, or pass --token-file <file>"

    if [ -n "${CREDENTIALS_FILE}" ]; then
        read_credentials_file
    elif [ -z "${BUCKET_KEY_ID}" ] && [ -t 0 ]; then
        printf '%s' "Bucket access key id (leave empty to use this machine's own credentials, e.g. an instance role): " >&2
        IFS= read -r BUCKET_KEY_ID || true

        if [ -n "${BUCKET_KEY_ID}" ]; then
            BUCKET_SECRET="$(ask_secret "Bucket secret access key (typing is not echoed): ")" || true
        fi
    fi

    if [ -n "${BUCKET_KEY_ID}" ] && [ -z "${BUCKET_SECRET}" ]; then
        die "a bucket access key id needs its secret access key"
    fi
}

# --- The service -------------------------------------------------------------

install_unit() {
    # BEGIN UNIT (apps/hostd/install/lunora-hostd.service; a test keeps them equal)
    cat > "${UNIT_PATH}.new" <<'UNIT'
# lunora-hostd: runs Lunora Cloud fleets on this server (plan 458 W7, W8).
# install.sh writes this file to /etc/systemd/system/lunora-hostd.service; it is
# also published with each hostd-v* release. Why each line is here:
# apps/hostd/README.md, "Isolation".
[Unit]
Description=Lunora hostd (runs Lunora Cloud fleets on this server)
Documentation=https://github.com/anolilab/lunora/tree/alpha/apps/hostd
Wants=network-online.target
After=network-online.target

[Service]
Type=simple
User=lunora-hostd
Group=lunora-hostd
ExecStart=/opt/lunora-hostd/current/lunora-hostd run
WorkingDirectory=/var/lib/lunora-hostd
# Files hostd creates are never world-readable; the fleet group gets what it needs explicitly.
UMask=0027

# Exit 0 after an upgrade replaced hostd (start the new one); exit 2 when the box
# was revoked (stay down until it is enrolled again).
Restart=always
RestartSec=5
RestartPreventExitStatus=2
# hostd stops on SIGTERM itself: fleets drain in parallel (45 s), then Caddy (10 s).
# Anything still running after that is killed with the whole cgroup.
KillMode=mixed
TimeoutStopSec=90

# The unit's cgroup is hostd's to manage: one child per fleet with memory.max.
Delegate=yes

# Only what hostd needs, and children get none of it (hostd starts each child
# through setpriv, which drops the inherited set; Caddy keeps net_bind_service):
#   NET_BIND_SERVICE  Caddy on ports 80 and 443
#   NET_ADMIN         the fleets' nftables egress table
#   SETUID, SETGID    start fleets as lunora-fleet, Caddy as lunora-edge
#   KILL              stop fleets, which run as another user
#   CHOWN             hand fleet directories to lunora-fleet
AmbientCapabilities=CAP_NET_BIND_SERVICE CAP_NET_ADMIN CAP_SETUID CAP_SETGID CAP_KILL CAP_CHOWN
CapabilityBoundingSet=CAP_NET_BIND_SERVICE CAP_NET_ADMIN CAP_SETUID CAP_SETGID CAP_KILL CAP_CHOWN
# Compatible with dropping to lunora-fleet: that is a setuid()/setgid() call made
# with CAP_SETUID/CAP_SETGID, not an exec of a set-user-ID helper.
NoNewPrivileges=yes

ProtectSystem=strict
ReadWritePaths=/var/lib/lunora-hostd /opt/lunora-hostd
ProtectHome=yes
PrivateTmp=yes
PrivateDevices=yes
ProtectKernelModules=yes
ProtectKernelLogs=yes
ProtectClock=yes
ProtectHostname=yes
# Also keeps hostd itself from setting a set-group-ID bit (chmod fails with EPERM): install.sh
# lays out Caddy's set-group-ID directories as root, and hostd only checks them.
RestrictSUIDSGID=yes
RestrictRealtime=yes
RestrictNamespaces=yes
LockPersonality=yes
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6 AF_NETLINK
SystemCallArchitectures=native
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
UNIT
    # END UNIT
    mv -f "${UNIT_PATH}.new" "${UNIT_PATH}"
    systemctl daemon-reload
}

enrol() {
    if ! needs_enrolment; then
        say "this box is enrolled already: upgraded in place (pass --force with a new token to enrol it again)"

        return
    fi

    [ -n "${TOKEN}" ] || die "no enrolment token: run install.sh in a terminal and paste it when asked, or pass --token-file <file>"

    # As lunora-hostd, so it owns what enrol writes. The secrets travel in its
    # environment only (exported in this subshell alone), never on a command line.
    (
        export LUNORA_HOSTD_ENROL_TOKEN="${TOKEN}"

        if [ -n "${BUCKET_KEY_ID}" ]; then
            export AWS_ACCESS_KEY_ID="${BUCKET_KEY_ID}" AWS_SECRET_ACCESS_KEY="${BUCKET_SECRET}"
        fi

        if [ -n "${BUCKET_SESSION}" ]; then
            export AWS_SESSION_TOKEN="${BUCKET_SESSION}"
        fi

        as_hostd "${INSTALL_DIR}/current/lunora-hostd" enrol "${ENROL_ARGS[@]}"
    ) || die "enrolment failed (see above); nothing was started"
}

start_service() {
    systemctl enable lunora-hostd.service > /dev/null 2>&1
    systemctl restart lunora-hostd.service
    say "lunora-hostd is running: systemctl status lunora-hostd; journalctl -u lunora-hostd -f"
}

main() {
    parse_args "$@"
    [ "$(id -u)" -eq 0 ] || die "run as root (sudo bash install.sh ...)"

    if [ "${UNINSTALL}" -eq 1 ]; then
        uninstall
        exit 0
    fi

    check_machine
    read_secrets
    install_packages
    check_openssl
    create_users
    create_directories
    install_release
    install_unit
    enrol
    start_service
}

# Sourced (the test:hostd lane does, to set a box up from these same functions), it only defines them.
if [ "${BASH_SOURCE[0]}" = "$0" ]; then
    main "$@"
fi
