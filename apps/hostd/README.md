# @lunora/hostd

`lunora-hostd` is the daemon a customer installs on their own server so Lunora
Cloud can run [celld](../../packages/platform-celld) fleets on it (plan 458). It
dials out over a WebSocket to the box's Durable Object in Lunora Cloud; the box
needs no inbound port for the control plane.

**Status:** the wire protocol, the signed release pipeline, the daemon (plan
458 W4, with the on-box halves of W5 and W6), `install.sh`, the systemd unit and
side-by-side upgrades (W7), and fleet isolation (W8) exist, with the
`test:hostd` lane over all of it. Not yet: a committed release key (so nothing
can be released or installed yet, see [below](#setting-up-the-release-key-maintainers)),
and forwarding hostd's own logs as OTLP (W6).

## Install

On a Debian or Ubuntu server (amd64 or arm64, 2 GB of memory, systemd), as root:

```sh
curl -fsSLO https://github.com/anolilab/lunora/releases/download/hostd-v<version>/install.sh
sha256sum install.sh   # compare with the release notes
sudo bash install.sh --control-plane https://<control plane origin> --bucket <bucket> --version <version> \
    [--endpoint <s3 url>] [--region <region>] [--single-trust]
```

It then asks for the **enrolment token** the studio shows — paste it; nothing
is echoed — and for the bucket's access key id and secret access key (the
secret is not echoed either; leave the key id empty to use the machine's own
credentials, such as an instance role). No secret goes on the command line,
where shell history, `ps` and sudo's log would keep it.

For automation, `--token-file <path>` and `--credentials-file <path>` (lines
`AWS_ACCESS_KEY_ID=…`, `AWS_SECRET_ACCESS_KEY=…`, optionally
`AWS_SESSION_TOKEN=…`; nothing else is read and nothing is evaluated) name files
that must belong to root and be readable by root alone (0600 or 0400).
`LUNORA_HOSTD_ENROL_TOKEN` and `AWS_*` already in the environment are used too.
`install.sh` takes them out of its environment at once, so nothing it runs
inherits them except `lunora-hostd enrol`, which gets them through its
environment alone. `--token` is refused, and so is `lunora-hostd enrol --token`.

`install.sh` ([`install/install.sh`](./install/install.sh)) installs any missing
`curl`, `jq`, `openssl`, `nftables`, `util-linux` (`setpriv`) and `gzip`; creates
the users `lunora-hostd` and `lunora-fleet` (system users, no shell, no home);
creates `/etc/lunora-hostd` (`lunora-hostd`, 0700), `/var/lib/lunora-hostd`
(`lunora-hostd:lunora-fleet`, 0710) and `/opt/lunora-hostd`; downloads and
verifies the release (below), and has `lunora-hostd install-release` install it
into `/opt/lunora-hostd/<releaseId>/` and point `/opt/lunora-hostd/current` at
it; writes `/etc/systemd/system/lunora-hostd.service`; runs `lunora-hostd enrol`
**as `lunora-hostd`**, passing the flags through; and enables and starts the
service. Every secret is gathered before anything is downloaded, so a missing
token fails at once.

**Which release.** `--version <version>` installs exactly that one. Without it,
`install.sh` installs the newest release on the box's channel: the newest
stable release, or — on a box that runs a pre-release, or with `--prerelease` —
the newest release of any kind. It reads that from `latest.json` on the GitHub
Release `hostd-latest` (`{"schema":1,"stable":…,"prerelease":…}`), which the
release workflow moves forward after each `hostd-v*` release
([`scripts/update-latest-pointer.mjs`](./scripts/update-latest-pointer.mjs);
each channel only ever moves forward), rather than from the repository's
release list, where a release per package per version pushes `hostd-v*` off
the first page at once. The pointer is a hint, not a trust root: the manifest
it leads to is verified like any other, and a release older than the installed
one is refused.

**Re-running it upgrades the box in place:** it installs the newest release on
the box's channel (or `--version`) beside the running one, switches `current`,
keeps the release that ran before (point `current` back at it to roll back),
removes older ones, rewrites the unit and restarts the service. An enrolled box
asks for nothing and is not enrolled again unless `--force` (and a new token)
is given.

**Uninstall:** `sudo bash install.sh --uninstall` stops and removes the unit,
the nftables table, `/opt/lunora-hostd`, `/var/lib/lunora-hostd`,
`/etc/lunora-hostd` and both users. It never touches the bucket: each fleet's
data stays under `fleets/<alias>/`, and `celld` can run it directly. Revoke the
box in the studio as well.

### What the studio's install command must say

The studio's enrol dialog (`installCommandFor` in
`apps/cloud/src/boxes/enrolment.ts`, on the `apps/cloud` branch) must show the
command **without the token**, and the token separately, to paste when asked:

```sh
curl -fsSLO https://github.com/anolilab/lunora/releases/download/hostd-v<version>/install.sh
sudo bash install.sh --control-plane <origin> --bucket <bucket> --version <version>
```

followed by "paste the token when prompted" and the token in a copy field of
its own. `<origin>` is this control plane (`LUNORA_ORIGIN_URL`; `enrol`
requires `--control-plane` until a production origin is compiled in),
`<version>` the release the control plane wants boxes on (its
`hostdReleases` entry, as `1.2.3`, the tag without `hostd-v`), and `<bucket>`
whatever the user typed (`--endpoint <url>` / `--region <region>` appended when
given). Neither the token nor a bucket credential may appear in the command:
`install.sh` asks for both at a hidden prompt. The old forms — `sudo lunora-hostd
enrol --token …`, and `LUNORA_HOSTD_ENROL_TOKEN=…` on the command line — leave
the token in shell history and sudo's log; `--token` is now refused.

### How install.sh trusts a release

1. **Trust root: the release keys pinned in `install.sh`** (`trusted_key()`, the
   same set as `HOSTD_TRUSTED_RELEASE_KEYS` in
   [`src/trusted-release-keys.ts`](./src/trusted-release-keys.ts); a test keeps
   them equal). `install.sh` itself comes over HTTPS from the GitHub Release,
   with its SHA-256 in the release notes and a provenance attestation.
2. It downloads `manifest.json`, looks its `keyId` up among the pinned keys
   (never a key the manifest brings), refuses a placeholder, checks that the
   pinned key's fingerprint is that key id (`ed25519-` + 16 hex digits of
   SHA-256 over the raw key), and verifies the Ed25519 signature over the
   canonical bytes with `openssl pkeyutl -verify` exactly as
   [protocol §8.2](../../protocol/hostd/README.md#82-signed-bytes) shows —
   **before** trusting any hash in it.
3. It downloads `lunora-hostd`, celld and Caddy for its platform (each capped at
   the size the manifest pins) into a root-owned directory beside
   `/opt/lunora-hostd`, and checks `lunora-hostd` against the size and SHA-256
   the verified manifest pins. That is the only binary the script runs from the
   release, and only because its bytes matched.
4. It runs that binary's `install-release` **as `lunora-hostd`**: the binary
   validates the manifest strictly and verifies it again with the keys
   compiled into it, then installs the release exactly as the `upgrade` job
   does (one implementation, `src/daemon/release-install.ts`): each file is
   checked against its size and SHA-256, decompressed, run once
   (`--version`), staged in `<releaseId>.partial/`, renamed into place, and
   `current` is switched in one rename. The release that ran before stays, for
   a rollback; older ones are removed. A release whose `lunora-hostd` is
   older than the installed one is refused (anti-rollback: an old release is
   still validly signed) unless `install.sh` is given `--allow-downgrade`.

The `upgrade` job does steps 2–4 inside the running daemon with the keys
compiled into it, downloading each artifact itself and refusing a downgrade
unless the job carries `allowDowngrade: true` (protocol §5.2), then exits for systemd to
restart into the new release (or restarts the fleets in place when
`lunora-hostd` itself did not change).

## The daemon

### Commands

| Command                                                     | What it does                                                                                                                             |
| ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `lunora-hostd enrol …`                                      | Binds the machine to an organization with the one-time token the studio shows, and writes the configuration                              |
| `lunora-hostd run`                                          | The daemon, in the foreground (what systemd runs). Exit 0 on SIGTERM or after replacing itself, 2 when revoked                           |
| `lunora-hostd status`                                       | The enrolment and the fleets, from the files on disk                                                                                     |
| `lunora-hostd install-release <manifest.json> --from <dir>` | Verify a release manifest with the compiled-in keys and install the files downloaded into `<dir>` as `upgrade` does (install.sh runs it) |

`enrol` takes `--control-plane <origin>` (required until a production origin
is published), `--bucket <name|s3://name>`, `--endpoint <url>` for an
S3-compatible store, `--region`, `--ipv4` / `--ipv6` (detected when omitted),
`--single-trust`, `--data-dir`, `--install-dir` (default `/opt/lunora-hostd`)
and `--force` (enrol again, as a new box). It
probes the bucket with `celld diagnose` before it spends the token. The token
comes only from `LUNORA_HOSTD_ENROL_TOKEN` (`--token` is refused: it would
leave the token in shell history and `ps`); the bucket credentials come only
from `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` /
`AWS_SESSION_TOKEN` in the environment. Neither is ever printed, and the
credentials never leave the box. Every command takes `--config <path>`
(default `/etc/lunora-hostd/config.json`, or `LUNORA_HOSTD_CONFIG`).

### Files

| Path                                    | Holds                                                                                   | Mode |
| --------------------------------------- | --------------------------------------------------------------------------------------- | ---- |
| `/etc/lunora-hostd/`                    | the directory below, `lunora-hostd`'s alone                                             | 0700 |
| `/etc/lunora-hostd/config.json`         | control-plane origin, box id and hostname, bucket name/endpoint/region, ports, paths    | 0640 |
| `/etc/lunora-hostd/box.key`             | the box's Ed25519 private key (PKCS#8 PEM)                                              | 0600 |
| `/etc/lunora-hostd/bucket.env`          | the bucket credentials (`AWS_*`); refused when anyone but the owner can read it         | 0600 |
| `/var/lib/lunora-hostd/state.json`      | each fleet's ports, state and last deployment                                           | 0600 |
| `/var/lib/lunora-hostd/releases/<id>/`  | a downloaded release: `worker.js`, `assets/`, `wrangler.json` (holds the app's secrets) | 0600 |
| `/var/lib/lunora-hostd/fleets/<alias>/` | a celld node's working directory, `HOME` and `TMPDIR`; owned by `lunora-fleet`          | 0700 |
| `/var/lib/lunora-hostd/caddy/`          | Caddy's config (`caddy.json`), certificates, and the JSON `access.log` hostd tails      |      |
| `/opt/lunora-hostd/<releaseId>/`        | one release: `lunora-hostd`, `celld`, `caddy` and its `manifest.json`                   | 0755 |
| `/opt/lunora-hostd/current`             | a link to the release that runs; the unit and every child start from it                 |      |

### What runs, and how

`lunora-hostd run` holds one WebSocket to the control plane and supervises
every other process as its child:

- **one celld node per deployment alias** (plan 458 D8): `celld --bucket
s3://<bucket>/fleets/<alias> [--endpoint] [--region] --listen
127.0.0.1:<port> --internal-listen 127.0.0.1:<port+1> --advertise
127.0.0.1:<port+1> --trust-forwarded-headers`, as `lunora-fleet` (see
  [Isolation](#isolation)), with `CELLD_DURABILITY=bucket` and
  `RUST_LOG=error,celld=warn` in an allowlisted environment. Both
  listeners are loopback; ports come in pairs from `ports` (default
  20000–20999). A `deploy` runs `celld deploy` on the release directory; a
  running node adopts the new version at its next pointer poll, without a
  restart;
- **Caddy**, configured through its JSON admin API on loopback from the
  `routes` the control plane pushes: each alias's hostnames proxy to its
  node, readiness-gated on `/.well-known/celld/health`, compressed (never an
  event stream), rate-limited per client, with on-demand TLS that hostd's own
  loopback `ask` endpoint approves only for routed hostnames and the box's own.

Children restart with a 1–30 s backoff; a stop is SIGTERM, then SIGKILL past
a budget; shutdown drains the fleets before Caddy. The control plane is the
source of truth: a fleet it stops routing is stopped (its data stays), and
`hello` reports the fleets on every connect. `destroy` with `deleteData`
deletes exactly the `fleets/<alias>/` prefix.

hostd refuses to run as root unless the config sets `allowRoot`; it runs as its
own user (`lunora-hostd`) under [`install/lunora-hostd.service`](./install/lunora-hostd.service).

## Isolation

The box is single-customer, but its apps run third-party npm code. What stands
between that code — should it escape celld's isolate — and the box's key, the
celld operator API and the rest of the machine (plan 458 W8, after Noite's
tenant sandbox):

- **Users.** `lunora-hostd` runs the daemon and Caddy and owns `/etc/lunora-hostd`
  (0700: the box key and the bucket credentials, 0600 each). Every celld
  process — each node, `celld deploy`, `celld diagnose` — runs as
  `lunora-fleet`. Neither user has a shell.
- **Capabilities.** The unit grants the daemon exactly `CAP_NET_BIND_SERVICE`
  (Caddy on 80/443), `CAP_NET_ADMIN` (the nftables table), `CAP_SETUID` and
  `CAP_SETGID` (starting fleets as `lunora-fleet`), `CAP_KILL` (stopping them)
  and `CAP_CHOWN` (handing them their directories), as ambient capabilities —
  which every program the daemon starts would inherit, across the uid change
  too. So every child is started through `setpriv`, which empties the
  inheritable and ambient sets and sets `no_new_privs` before executing it:
  a fleet runs with no capabilities, Caddy with `net_bind_service` alone.
- **Environment.** A fleet's environment is built from nothing and held to an
  allowlist (`PATH`, `HOME`/`TMPDIR` = its own directory, `LANG`, celld's
  `RUST_LOG` and `CELLD_DURABILITY`, `AWS_*` for the bucket): never the config
  path, the control plane's origin, the enrolment token or systemd's variables.
- **Egress.** hostd installs the nftables table `inet lunora_hostd` at start: for
  sockets of the fleet uid only, it accepts replies on established connections,
  DNS, and the bucket endpoint's resolved addresses on its port (re-resolved
  every 30 s), and rejects loopback, RFC 1918, link-local (with the
  `169.254.169.254` metadata service), CGNAT `100.64.0.0/10`, `0.0.0.0/8`,
  and IPv6 loopback, unspecified, v4-mapped, ULA and link-local. That keeps a
  fleet from every celld operator API (each node's internal listener is on
  loopback, siblings' included), hostd's on-demand-TLS `ask` endpoint and
  Caddy's admin API.
- **Memory.** With `Delegate=yes`, hostd moves itself into `hostd/` under its
  service cgroup, enables the memory controller, and puts each fleet's node in
  `fleet-<alias>/` with `memory.max` (the box's memory less 512 MiB, at least
  256 MiB, or `fleetMemoryMaxMb` in the config) and no swap.

**The self-check.** At start hostd checks all three: a process started as
`lunora-fleet` really has that uid, no capabilities and `no_new_privs`; the
nftables table is loaded; the delegated cgroup takes the memory controller.
All pass: `enforced`. One fails on a box enrolled with `--single-trust`:
`single-trust`, and fleets start with whatever does work. One fails otherwise:
`refused` — no fleet starts and a `deploy` fails with `ISOLATION_FAILED`. Each
failed check is logged, printed by `diagnose`, and sent in every `hello`
(`isolation`, protocol §5.1).

**The unit** ([`install/lunora-hostd.service`](./install/lunora-hostd.service))
adds `ProtectSystem=strict` with only `/var/lib/lunora-hostd` and
`/opt/lunora-hostd` writable (not `/etc/lunora-hostd`: the running daemon never
writes its key or config), `ProtectHome`, `PrivateTmp`, `PrivateDevices`,
`RestrictSUIDSGID`, `RestrictNamespaces`, `LockPersonality`, the address
families it uses, `UMask=0027`, `KillMode=mixed` with `TimeoutStopSec=90` (fleets
drain in parallel within 45 s, then Caddy within 10 s), `Restart=always`, and
`RestartPreventExitStatus=2` so a revoked box stays down.

`NoNewPrivileges=yes` is compatible with dropping to `lunora-fleet`: that is a
`setuid()`/`setgid()` call made with `CAP_SETUID`/`CAP_SETGID`, which
`no_new_privs` does not restrict; what it rules out is an exec gaining
privilege (a set-user-ID helper like `sudo` or `runuser`, or file
capabilities). The trade-off is that Caddy cannot be given
`cap_net_bind_service` as a file capability — hence the ambient capability,
narrowed by `setpriv`. Left out on purpose: `ProtectControlGroups` and
`ProtectKernelTunables` (both make `/sys/fs/cgroup` read-only, which the
delegated cgroup needs), `MemoryDenyWriteExecute` (V8 compiles code at run
time) and a `SystemCallFilter` (celld's needs are not pinned down yet).

### Known limits

- **One fleet user per box.** All fleets share `lunora-fleet`: a fleet that
  escapes its isolate can read another fleet's working directory and the
  release files it deploys from (which hold that app's secrets). The box serves
  one organization.
- **The bucket key is the box's.** Every fleet gets the credentials hostd holds,
  which reach the whole bucket, not just `fleets/<alias>/`. Scoping them needs a
  store that mints prefix-scoped credentials (AWS STS session policies, R2's
  temporary credentials, MinIO's STS) and a refresh before they expire; hostd
  does not do that yet. Secrets live in the bucket anyway (plan 458 D10).
- **The public internet is open.** A fleet may reach any public address,
  including the box's own public IPs — any service the box exposes publicly
  (say `sshd`) is reachable from a fleet as from anywhere. DNS (port 53) is open
  to every address, and the bucket endpoint's port is open on its addresses
  even when they are private (a MinIO on the LAN).
- **Memory only.** No CPU, pids or I/O limit per fleet yet, and a fleet's first
  milliseconds (between spawn and the move into its cgroup) are charged to
  `hostd/`.
- **Caddy runs as `lunora-hostd`.** It parses untrusted HTTP with the same uid
  that can read the box key.
- **No `esbuild` on the box, by design.** A stored release is already bundled,
  and `celldConfigFromRelease` deploys it with `no_bundle: true`, so neither
  `celld deploy` nor the node calls esbuild — checked against celld v0.6.0 with
  a Worker that imports `cloudflare:workers`, deployed to an S3 bucket and served
  with no esbuild on `PATH`. A config without `no_bundle` would fail with
  "esbuild not found"; never hand `celld deploy` one.
- **The customer has root.** Nothing on the box is hidden from them; nothing
  billed depends on what the box reports (plan 458 D12).

## The `test:hostd` lane

`pnpm run test:hostd` (vitest project `integration`, gated behind
`LUNORA_HOSTD_TESTS=1`) drives the built daemon against real celld, a Caddy
built with `caddy-ratelimit`, an S3-compatible bucket and an in-process fake
control plane: enrol, session, deploy, HTTP through Caddy, a usage report,
destroy with `deleteData`. It reads `LUNORA_CELLD_BIN`, `LUNORA_CADDY_BIN`,
`LUNORA_HOSTD_S3_ENDPOINT` and, optionally, `LUNORA_HOSTD_BIN` (the single
executable; otherwise `dist/bin.mjs`). With `LUNORA_HOSTD_ISOLATION=1`, as root
on a systemd host (the `hostd integration` CI job, under sudo), it sets the box
up with `install.sh`'s own functions, runs hostd under the real unit with Caddy
on port 80, and asserts the isolation with probes from inside a deployed app and
as the fleet user. See [`__tests__/integration/lane.ts`](./__tests__/integration/lane.ts).

## Wire protocol

`@lunora/hostd/protocol` holds the message types, the strict validators and the
signing payloads both sides use. It has no runtime dependencies and runs in Node
and workerd. The normative contract is
[`protocol/hostd/README.md`](../../protocol/hostd/README.md).

```ts
import { decodeBoxMessage, encodeMessage, negotiateProtocolVersion, peekProtocolVersion } from "@lunora/hostd/protocol";

const offered = peekProtocolVersion(frame);
const negotiation = negotiateProtocolVersion(offered ?? 0);

if (!negotiation.ok) {
    socket.send(encodeMessage({ code: negotiation.code, message: negotiation.message, type: "error" }));
    socket.close();
}

const decoded = decodeBoxMessage(frame); // never throws
```

`apps/cloud` depends on this package; this package never depends on
`apps/cloud`.

## Releases & signing

A box installs `hostd`, celld and Caddy from a **signed release manifest**
(plan 458 W7, §9 Q2). The manifest pins every binary, per platform
(`linux-x64`, `linux-arm64`), by URL, SHA-256 and size. It is signed with
**Ed25519** over its canonical bytes, and the public key that verifies it is
compiled into `hostd` and the control plane
([`src/trusted-release-keys.ts`](./src/trusted-release-keys.ts)). Verifying
needs only WebCrypto; nothing like minisign or Sigstore runs on the box.
GitHub artifact attestations add build provenance on top
(`gh attestation verify <file> --repo anolilab/lunora`), but a box does not
need them. The byte-level format, for implementations in any language, is §8 of
[`protocol/hostd/README.md`](../../protocol/hostd/README.md).

```ts
import { HOSTD_TRUSTED_RELEASE_KEYS, verifyReleaseManifest } from "@lunora/hostd/release";
import { verifyArtifact } from "@lunora/hostd/release/verify";

const verified = await verifyReleaseManifest(JSON.parse(manifestJson), HOSTD_TRUSTED_RELEASE_KEYS);

if (verified.ok) {
    const [artifact] = verified.envelope.manifest.hostd.artifacts;
    const checked = await verifyArtifact(downloadedPath, artifact.sha256, artifact.size);
}
```

`@lunora/hostd/release` (types, validator, canonical bytes, and
`verifyReleaseManifest` on WebCrypto) has no Node imports and runs in workerd —
the control plane verifies a release with the same function a box does.
`@lunora/hostd/release/verify` (signing, artifact hashing) is Node only.

### Building

- `pnpm run build:sea` builds `dist/sea/lunora-hostd-<os>-<arch>` for the
  machine it runs on: an esbuild bundle of `src/bin.ts`, injected into a copy of
  the running `node` with postject (Node 24 has no built-in `--build-sea`). The
  binary embeds that exact Node, so build with the version boxes should run
  (CI uses the `.nvmrc` line). Linux only.
- **Caddy is built from pinned source.** No upstream Caddy release includes the
  `caddy-ratelimit` module the box edge needs, so the release workflow builds
  it with xcaddy on each platform's runner: the Caddy version and each module's
  commit come from [`release-pins.json`](./release-pins.json), Go and xcaddy are
  pinned in the workflow. The build is reproducible (CGO off, `-trimpath`, no
  VCS stamping, `gzip -n`), is smoke-tested with `caddy version` and
  `caddy list-modules` (it must list `http.handlers.rate_limit`), and ships as
  `caddy-<platform>.gz` on the same GitHub Release, next to `install.sh` and
  `lunora-hostd.service`.
- `scripts/make-release-manifest.mjs` writes and signs `manifest.json`: `hostd`
  and Caddy entries are hashed from the built files in `--artifacts-dir`
  (`lunora-hostd-<platform>`, `caddy-<platform>.gz`), celld entries and the
  Caddy version + module list come from `release-pins.json`. `--verify` checks
  an envelope (and, with `--artifacts-dir`, the hostd and Caddy files). It
  refuses to sign while an input is missing or a placeholder, or when the
  signature does not verify against a key pinned in
  `src/trusted-release-keys.ts`.
- `.github/workflows/hostd-release.yml` does all of it on a `hostd-v<version>`
  tag or a manual dispatch: build and test, single executables and Caddy on x64
  and arm64 runners with smoke tests, sign, verify, attest, publish the GitHub
  Release `hostd-v<version>`. The committed `package.json` version stays
  `0.0.0`; the workflow stamps the released version before building.

celld is pinned to `denoland/celld` v0.6.0, the release the celld CI lane tests.
Keep the two in step.

### What is not real yet

- **No release key is committed.** `src/trusted-release-keys.ts` and
  `install/install.sh` hold a placeholder, which verification, signing and
  `install.sh` refuse. That is the only manual step left before a first
  release: a maintainer generates the key, commits its public half to both and
  sets the `hostd-release` environment secret (below). Until then the release
  workflow builds and smoke-tests every binary, then stops at the signing step.

### Setting up the release key (maintainers)

1. Generate the key pair on a trusted machine:
   `openssl genpkey -algorithm ed25519 -out hostd-release.pem`.
2. Print the public half and its key id:
   `pnpm --filter @lunora/hostd run build && node apps/hostd/scripts/release-public-key.mjs hostd-release.pem`.
   The key id is `ed25519-` plus the first 16 hex digits of SHA-256 over the
   raw public key, so it cannot drift from the key.
3. Commit the two printed entries — to `HOSTD_TRUSTED_RELEASE_KEYS` in
   `src/trusted-release-keys.ts` and to `trusted_key()` in `install/install.sh`
   — and delete both placeholder entries.
4. Create the GitHub Environment `hostd-release` with a required reviewer, and
   store the **whole PEM file** as its secret `HOSTD_RELEASE_SIGNING_KEY`.
5. Keep an offline backup of `hostd-release.pem`, then delete the local copy.

To rotate, add the new public key next to the old one, switch the secret, and
remove the old key only once no supported `hostd` still pins it. A box trusts
only the keys compiled into the binary it runs, so a new key reaches boxes
through a release signed with a key they already trust.

## License

[FSL-1.1-Apache-2.0](./LICENSE.md): use it for any purpose except a Competing
Use; each release converts to Apache-2.0 two years after it ships.
