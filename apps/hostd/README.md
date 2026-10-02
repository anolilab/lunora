# @lunora/hostd

`lunora-hostd` is the daemon a customer installs on their own server so Lunora
Cloud can run [celld](../../packages/platform-celld) fleets on it (plan 458). It
dials out over a WebSocket to the box's Durable Object in Lunora Cloud; the box
needs no inbound port for the control plane.

**Status:** the wire protocol, the signed release pipeline and the daemon
itself (plan 458 W4, with the on-box halves of W5 and W6) exist. Not yet:
`install.sh` and the systemd unit (W7), uid separation and the network
sandbox for fleets (W8), and forwarding hostd's own logs as OTLP (W6).

## The daemon

### Commands

| Command                | What it does                                                                                                   |
| ---------------------- | -------------------------------------------------------------------------------------------------------------- |
| `lunora-hostd enrol …` | Binds the machine to an organization with the one-time token the studio shows, and writes the configuration    |
| `lunora-hostd run`     | The daemon, in the foreground (what systemd runs). Exit 0 on SIGTERM or after replacing itself, 2 when revoked |
| `lunora-hostd status`  | The enrolment and the fleets, from the files on disk                                                           |

`enrol` takes `--control-plane <origin>` (required until a production origin
is published), `--bucket <name|s3://name>`, `--endpoint <url>` for an
S3-compatible store, `--region`, `--ipv4` / `--ipv6` (detected when omitted),
`--single-trust`, `--data-dir` and `--force` (enrol again, as a new box). It
probes the bucket with `celld diagnose` before it spends the token. The token
may come from `--token` or `LUNORA_HOSTD_ENROL_TOKEN`; the bucket credentials
come only from `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` /
`AWS_SESSION_TOKEN` in the environment. Neither is ever printed, and the
credentials never leave the box. Every command takes `--config <path>`
(default `/etc/lunora-hostd/config.json`, or `LUNORA_HOSTD_CONFIG`).

### Files

| Path                                      | Holds                                                                                   | Mode |
| ----------------------------------------- | --------------------------------------------------------------------------------------- | ---- |
| `/etc/lunora-hostd/config.json`           | control-plane origin, box id and hostname, bucket name/endpoint/region, ports, binaries | 0640 |
| `/etc/lunora-hostd/box.key`               | the box's Ed25519 private key (PKCS#8 PEM)                                              | 0600 |
| `/etc/lunora-hostd/bucket.env`            | the bucket credentials (`AWS_*`); refused when anyone but the owner can read it         | 0600 |
| `/var/lib/lunora-hostd/state.json`        | each fleet's ports, state and last deployment                                           | 0600 |
| `/var/lib/lunora-hostd/releases/<id>/`    | a downloaded release: `worker.js`, `assets/`, `wrangler.json` (holds the app's secrets) | 0600 |
| `/var/lib/lunora-hostd/fleets/<alias>/`   | a celld node's working directory                                                        |      |
| `/var/lib/lunora-hostd/caddy/`            | Caddy's config (`caddy.json`), certificates, and the JSON `access.log` hostd tails      |      |
| `/var/lib/lunora-hostd/bin/{celld,caddy}` | the binaries hostd runs and an `upgrade` replaces (paths overridable in the config)     |      |

### What runs, and how

`lunora-hostd run` holds one WebSocket to the control plane and supervises
every other process as its child:

- **one celld node per deployment alias** (plan 458 D8): `celld --bucket
s3://<bucket>/fleets/<alias> [--endpoint] [--region] --listen
127.0.0.1:<port> --internal-listen 127.0.0.1:<port+1> --advertise
127.0.0.1:<port+1> --trust-forwarded-headers`, with `CELLD_DURABILITY=bucket`
  and `RUST_LOG=error,celld=warn` in an otherwise cleared environment. Both
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

hostd refuses to run as root unless the config sets `allowRoot`; it is meant
to run as its own user (`lunora-hostd`), with `CAP_NET_BIND_SERVICE` handed to
Caddy for ports 80/443. W8 will run the fleets as a separate `lunora-fleet`
user (the supervisor already takes a uid/gid per child).

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
  `caddy-<platform>.gz` on the same GitHub Release.
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

- **No release key is committed.** `src/trusted-release-keys.ts` holds a
  placeholder, which verification and signing refuse. That is the only manual
  step left before a first release: a maintainer generates the key, commits its
  public half and sets the `hostd-release` environment secret (below). Until
  then the release workflow builds and smoke-tests every binary, then stops at
  the signing step.

### Setting up the release key (maintainers)

1. Generate the key pair on a trusted machine:
   `openssl genpkey -algorithm ed25519 -out hostd-release.pem`.
2. Print the public half and its key id:
   `pnpm --filter @lunora/hostd run build && node apps/hostd/scripts/release-public-key.mjs hostd-release.pem`.
   The key id is `ed25519-` plus the first 16 hex digits of SHA-256 over the
   raw public key, so it cannot drift from the key.
3. Commit the printed entry to `HOSTD_TRUSTED_RELEASE_KEYS` in
   `src/trusted-release-keys.ts` and delete the placeholder entry.
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
