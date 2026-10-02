# @lunora/hostd

`lunora-hostd` is the daemon a customer installs on their own server so Lunora
Cloud can run [celld](../../packages/platform-celld) fleets on it (plan 458). It
dials out over a WebSocket to the box's Durable Object in Lunora Cloud; the box
needs no inbound port for the control plane.

**Status:** the wire protocol and the signed release pipeline exist.
Enrolment, the session and the supervisor arrive with plan 458 W4; the
`lunora-hostd` binary answers `--version` and `--help` and refuses everything
else.

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
