#!/usr/bin/env bash
# Installs, upgrades or removes lunora-hostd on a Debian or Ubuntu server
# (plan 458 W7). Published with every hostd-v* GitHub Release; the release
# notes give its SHA-256.
#
#   curl -fsSLO https://github.com/anolilab/lunora/releases/download/hostd-v<version>/install.sh
#   sudo LUNORA_HOSTD_ENROL_TOKEN=lbe_... AWS_ACCESS_KEY_ID=... AWS_SECRET_ACCESS_KEY=... \
#       bash install.sh --control-plane https://<cloud> --bucket <name> [--endpoint <url>]
#
# Re-running it upgrades the box in place to the latest release (or --version).
# `--uninstall` removes hostd, its users, unit and files, and never the bucket.
#
# Trust: this script pins the Ed25519 release keys (TRUSTED RELEASE KEYS below,
# the same set compiled into lunora-hostd) and checks each key's fingerprint.
# It verifies the release manifest's signature with OpenSSL before trusting any
# hash in it (protocol/hostd/README.md §8), checks lunora-hostd against the
# manifest's SHA-256 and size, then has that binary verify the manifest again
# with its own strict verifier, and checks celld and Caddy against it too.
#
# The enrolment token and the bucket credentials are read from the environment
# (or --token), handed to `lunora-hostd enrol` through its environment, never
# its command line, and never printed.
set -euo pipefail

REPOSITORY="anolilab/lunora"
INSTALL_DIR="/opt/lunora-hostd"
CONFIG_DIR="/etc/lunora-hostd"
DATA_DIR="/var/lib/lunora-hostd"
UNIT_PATH="/etc/systemd/system/lunora-hostd.service"
HOSTD_USER="lunora-hostd"
FLEET_USER="lunora-fleet"
NFT_TABLE="lunora_hostd"
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
  --token <token>            the enrolment token (or LUNORA_HOSTD_ENROL_TOKEN)
  --version <version>        install this release instead of the latest

Remove:
  --uninstall                remove hostd, its users and files (never the bucket)

Bucket credentials come from AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY
(/ AWS_SESSION_TOKEN) in the environment.
USAGE
}

VERSION=""
TOKEN="${LUNORA_HOSTD_ENROL_TOKEN:-}"
UNINSTALL=0
FORCE=0
ENROL_ARGS=()
PLATFORM=""
RELEASE_ID=""
TAG=""

need_value() {
    [ "$#" -ge 2 ] && [ -n "$2" ] || die "$1 needs a value"
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
            --token)
                need_value "$@"
                TOKEN="$2"
                shift 2
                ;;
            --version)
                need_value "$@"
                VERSION="${2#v}"
                shift 2
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

    for user in "${HOSTD_USER}" "${FLEET_USER}"; do
        if id -u "${user}" > /dev/null 2>&1; then
            userdel "${user}"
        fi
    done

    say "done. Revoke the box in the Lunora Cloud studio; its fleets' data stays in your bucket under fleets/."
}

# --- The machine -------------------------------------------------------------

check_machine() {
    local id="" id_like=""

    if [ -r /etc/os-release ]; then
        # shellcheck disable=SC1091 # the running system's os-release, not a file in this repository
        id="$(. /etc/os-release && printf '%s' "${ID:-}")"
        # shellcheck disable=SC1091
        id_like="$(. /etc/os-release && printf '%s' "${ID_LIKE:-}")"
    fi

    case " ${id} ${id_like} " in
        *" debian "* | *" ubuntu "*) ;;
        *) die "this installer supports Debian and Ubuntu (found '${id:-unknown}')" ;;
    esac

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

    if ! id -u "${FLEET_USER}" > /dev/null 2>&1; then
        useradd --system --user-group --home-dir /nonexistent --no-create-home --shell /usr/sbin/nologin "${FLEET_USER}"
    fi
}

create_directories() {
    # The key and the bucket credentials: lunora-hostd's alone.
    install -d -o "${HOSTD_USER}" -g "${HOSTD_USER}" -m 0700 "${CONFIG_DIR}"
    # The fleet group may pass through (to its working directory), never list.
    install -d -o "${HOSTD_USER}" -g "${FLEET_USER}" -m 0710 "${DATA_DIR}"
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

fetch() {
    # HTTPS only, also across redirects (GitHub serves assets from its CDN).
    curl -fsSL --proto '=https' --proto-redir '=https' --tlsv1.2 --retry 3 -o "$2" "$1"
}

resolve_tag() {
    if [ -n "${VERSION}" ]; then
        [[ "${VERSION}" =~ ^[0-9][A-Za-z0-9_.+~-]{0,63}$ ]] || die "not a release version: ${VERSION}"
        TAG="hostd-v${VERSION}"

        return
    fi

    fetch "https://api.github.com/repos/${REPOSITORY}/releases?per_page=100" "${WORK}/releases.json"
    TAG="$(jq -r '[.[] | select(.draft == false and .prerelease == false and (.tag_name | startswith("hostd-v")))][0].tag_name // empty' "${WORK}/releases.json")"
    [ -n "${TAG}" ] || die "no stable hostd release is published yet; pass --version <version>"
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

# Download one component for this platform and check its size and SHA-256 against the manifest.
download_component() {
    local component="$1" out="$2" entry url sha256 size

    entry="$(jq -c --arg c "${component}" --arg p "${PLATFORM}" '.manifest[$c].artifacts[] | select(.platform == $p)' "${WORK}/manifest.json")"
    [ -n "${entry}" ] || die "release ${RELEASE_ID} ships no ${component} for ${PLATFORM}"
    url="$(jq -r '.url' <<< "${entry}")"
    sha256="$(jq -r '.sha256' <<< "${entry}")"
    size="$(jq -r '.size' <<< "${entry}")"
    [[ "${url}" =~ ^https:// && "${sha256}" =~ ^[0-9a-f]{64}$ && "${size}" =~ ^[0-9]+$ ]] || die "the manifest's ${component} entry is malformed"

    say "downloading ${component} ($((size / 1048576)) MiB)"
    curl -fsSL --proto '=https' --proto-redir '=https' --tlsv1.2 --retry 3 --max-filesize "${size}" -o "${out}" "${url}"
    [ "$(stat -c %s "${out}")" -eq "${size}" ] || die "${component}: the download is not the ${size} bytes the manifest pins"
    printf '%s  %s\n' "${sha256}" "${out}" | sha256sum --check --status || die "${component}: SHA-256 does not match the manifest"

    if [ "$(jq -r '.compression // empty' <<< "${entry}")" = "gzip" ]; then
        gzip -dc "${out}" > "${out}.bin"
    else
        cp "${out}" "${out}.bin"
    fi
}

install_release() {
    WORK="$(mktemp -d)"
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

    local target="${INSTALL_DIR}/${RELEASE_ID}"
    local staging="${target}.partial"

    # Staged under the install directory, not the temporary one, which may be mounted noexec.
    rm -rf -- "${staging}"
    install -d -m 0755 "${staging}"
    install -m 0755 "${WORK}/lunora-hostd.bin" "${staging}/lunora-hostd"
    install -m 0755 "${WORK}/celld.bin" "${staging}/celld"
    install -m 0755 "${WORK}/caddy.bin" "${staging}/caddy"
    install -m 0644 "${WORK}/manifest.json" "${staging}/manifest.json"

    # lunora-hostd's bytes match the manifest this script verified; now its own,
    # strict verifier checks the manifest and every download again.
    "${staging}/lunora-hostd" verify-release "${WORK}/manifest.json" --platform "${PLATFORM}" \
        --hostd "${WORK}/lunora-hostd" --celld "${WORK}/celld" --caddy "${WORK}/caddy" > /dev/null ||
        die "lunora-hostd refused the release"
    "${staging}/celld" --version > /dev/null || die "celld does not run on this machine"
    "${staging}/caddy" version > /dev/null || die "caddy does not run on this machine"

    local previous=""

    if [ -L "${INSTALL_DIR}/current" ]; then
        previous="$(basename "$(readlink "${INSTALL_DIR}/current")")"
    fi

    chown -R "${HOSTD_USER}:${HOSTD_USER}" "${staging}"
    rm -rf -- "${target}"
    mv -T "${staging}" "${target}"
    ln -sfn "${RELEASE_ID}" "${INSTALL_DIR}/current.next"
    chown -h "${HOSTD_USER}:${HOSTD_USER}" "${INSTALL_DIR}/current.next"
    mv -T "${INSTALL_DIR}/current.next" "${INSTALL_DIR}/current"
    say "installed ${RELEASE_ID} at ${target}"

    # Keep the release that ran before (for a rollback: point current back at it); remove older ones.
    local release

    for release in "${INSTALL_DIR}"/*/; do
        release="$(basename "${release}")"

        if [ ! -L "${INSTALL_DIR}/${release}" ] && [ "${release}" != "${RELEASE_ID}" ] && [ "${release}" != "${previous}" ] &&
            [ -f "${INSTALL_DIR}/${release}/manifest.json" ]; then
            rm -rf -- "${INSTALL_DIR:?}/${release}"
        fi
    done
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
#   SETUID, SETGID    start fleets as lunora-fleet
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
    if [ -f "${CONFIG_DIR}/config.json" ] && [ "${FORCE}" -eq 0 ]; then
        say "this box is enrolled already: upgraded in place (pass --force with a new token to enrol it again)"

        return
    fi

    [ -n "${TOKEN}" ] || die "no enrolment token: pass --token or set LUNORA_HOSTD_ENROL_TOKEN (the studio shows one)"

    # As lunora-hostd, so it owns what enrol writes. The token travels in the
    # environment only, never on a command line another user can read.
    (
        cd "${DATA_DIR}"
        export LUNORA_HOSTD_ENROL_TOKEN="${TOKEN}"
        exec setpriv --reuid="${HOSTD_USER}" --regid="${HOSTD_USER}" --init-groups -- \
            "${INSTALL_DIR}/current/lunora-hostd" enrol "${ENROL_ARGS[@]}"
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
    install_packages
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
