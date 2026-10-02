# hostd ↔ control-plane protocol (version 1)

The wire contract between `lunora-hostd`, the daemon a customer runs on their
own server, and Lunora Cloud's per-box Durable Object (plan 458, decisions D1,
D4, D6, D15–D17). `hostd` dials **out**; the box never accepts an inbound
connection.

This document is normative. The golden frames in
[`fixtures/messages.json`](./fixtures/messages.json) are its machine-checkable
form: the reference implementation is tested against them
(`apps/hostd/__tests__/protocol.test.ts`), and an implementation in any other
language should run the same file.

- Reference implementation: `apps/hostd/src/protocol.ts`, published inside the
  workspace as `@lunora/hostd/protocol` (zero dependencies; runs in Node and
  workerd).
- Unrelated to the client↔server protocol in [`../README.md`](../README.md):
  different peers, different endpoint, no shared frames.

## 1. Transport

| Concern               | Transport           | Who starts it |
| --------------------- | ------------------- | ------------- |
| control session       | WebSocket (`wss:`)  | box           |
| release download (D6) | HTTPS `GET`, signed | box           |

One WebSocket per box. Every frame is **one UTF-8 JSON object** with a string
`type`. Implementations SHOULD send text frames; a receiver MUST also accept a
binary frame holding the same UTF-8 bytes. JSON numbers are IEEE-754 doubles;
every integer field below is a non-negative safe integer (≤ 2^53 − 1) unless
stated otherwise.

The two directions use **disjoint** `type` sets, so a frame names its own
direction, and a frame of the other direction's type is rejected as unknown.

## 2. Session

```text
box                                         control plane
 |-- WebSocket upgrade ------------------------>|
 |-- hello {protocol, boxId, ...} ------------->|  peek protocol, negotiate (§3)
 |<---------------------------- challenge {nonce}|
 |-- auth {signature} ------------------------->|  verify Ed25519 over §6.1
 |<------------------------------ routes {table}|  full table
 |<------------------------- config {telemetry?}|  runtime configuration
 |<------------------------ job {jobId, job} ...|
 |-- progress {jobId, line} ... --------------->|
 |-- result {jobId, ok, ...} ------------------>|  exactly one per job
 |<------------------------------------- ping   |
 |-- pong ------------------------------------->|
 |-- report {windowStart, windowEnd, ...} ----->|  periodic
 |<---------------- error {code, message} + close|  on refusal
```

1. The box sends `hello` first, and only once.
2. The control plane answers with one `challenge`. The box answers with `auth`.
   The control plane sends nothing else before it has verified `auth`; a bad
   signature gets `error {code: "AUTH_FAILED"}` and a close.
3. After `auth`, the control plane pushes the full `routes` table, then on
   every change. Each `routes` replaces the previous table; it is never a delta.
   It sends a `config` after `auth` too, and again whenever it changes; each
   `config` replaces the previous one. A box that has not received one forwards
   no logs.
4. Each `job` carries a `jobId` unique to the box. The box streams any number of
   `progress` frames for it and ends it with exactly one `result`.
5. `ping` may be sent at any time after `auth`; the box answers `pong`.
6. To refuse a box (protocol mismatch, failed auth, revoked key), the control
   plane sends one `error` and closes the socket. The box SHOULD back off before
   reconnecting, and SHOULD NOT reconnect after `BOX_REVOKED` until re-enrolled.

## 3. Version negotiation

The current version is **1** (`HOSTD_PROTOCOL_VERSION`). A version is an
integer that only grows; any change a peer of the previous version could
misread bumps it.

- Version 1 was still being completed before the first `lunora-hostd`
  release: the `config` frame and `upgrade.allowDowngrade` (§5.2) joined it
  then, and every released box of version 1 accepts both. From the first
  release on, a change an older box would reject bumps the version.
- The box announces the single version it speaks in `hello.protocol`.
- The control plane speaks a set of versions. If `hello.protocol` is in the
  set, the session runs at that version. Otherwise it sends
  `error {code: "PROTOCOL_UNSUPPORTED", message}` and closes. The message says
  which side is behind: an older box is told to upgrade `lunora-hostd`; a newer
  box is told the control plane does not support it yet.
- **Frozen fields.** `hello.type`, `hello.protocol` and the whole `error` frame
  never change shape across versions. A receiver MUST read `hello.protocol`
  _before_ strictly validating the rest of `hello` (reference:
  `peekProtocolVersion`), because a newer `hello` may carry fields this version
  rejects as unknown, and the operator must get `PROTOCOL_UNSUPPORTED`, not a
  validation error.

## 4. Validation and caps

Decoding is **strict**: a frame is rejected if it is not a JSON object, if its
`type` is unknown for that direction, or if any object (top level, nested, or an
array entry) has a missing required field, a field of the wrong type, or an
**unknown field**. Optional fields are omitted when absent (never `null`).

| Cap                                     | Value                   |
| --------------------------------------- | ----------------------- |
| encoded frame                           | 262 144 bytes (256 KiB) |
| `progress.line`                         | 8 192 UTF-8 bytes       |
| `result.error.message`, `error.message` | 8 192 UTF-8 bytes       |
| `hello.fleets`                          | 500 entries             |
| `report.perAlias`                       | 500 entries             |
| `routes.table`                          | 2 000 entries           |
| `job.crons` (deploy)                    | 64 entries, ≤ 256 chars |
| `config.telemetry.token`                | 512 characters          |
| URLs                                    | 2 048 characters        |
| alias                                   | 63 characters           |
| hostname                                | 253 characters          |

Cloudflare caps a WebSocket message at 1 MiB; a frame stays at a quarter of
that because nothing large belongs on the socket. **Releases never travel over
the socket** (D6): a deploy job carries a URL, and the box fetches the release
over signed HTTPS (§6.2).

The `routes.table` cap is set so that a full table of default hostnames
(`<alias>.<box>.boxes.lunora.app`) still fits one frame with room to spare. A
box serves one organization (plan 458 §3 rule 6), so 2 000 routes is far above
any real box; a box that needs more needs a protocol version that splits the
table.

Rejection reasons, as the reference decoder reports them:

| Code              | Meaning                                                        |
| ----------------- | -------------------------------------------------------------- |
| `FRAME_TOO_LARGE` | the frame is over the frame cap                                |
| `INVALID_JSON`    | the frame is not UTF-8 JSON                                    |
| `UNKNOWN_TYPE`    | `type` is missing or not a type this direction sends           |
| `INVALID_MESSAGE` | a field is missing, unknown, mistyped, or over a cap; see path |

The decoder reports the offending field as a JSONPath-like `path`
(`$.job.alias`, `$.table[3].hostname`).

### 4.1 Field formats

| Name           | Format                                                                                                                                                                            |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| id             | `^[A-Za-z0-9_-]{1,128}$`. Used for `boxId`, `jobId`, `deploymentId`, `releaseId`. Never contains `:` or a newline, so it cannot break a signing payload.                          |
| alias          | `^[a-z0-9]+(-[a-z0-9]+)*$`, at most 63 characters: one DNS label. Same pattern as `ALIAS_PATTERN` in `apps/cloud/src/provision-contract.ts`.                                      |
| hostname       | Lowercase DNS name: labels of `[a-z0-9-]`, 1–63 characters, no leading or trailing `-`; at most 253 characters; no trailing dot; no port; no wildcard; last label not all digits. |
| nonce          | base64url without padding, 22–128 characters (at least 128 bits).                                                                                                                 |
| signature      | Ed25519 signature, base64url without padding: exactly 86 characters.                                                                                                              |
| version string | `^[A-Za-z0-9_.+~-]{1,64}$` (e.g. `v2.8.4`, `1.0.0-alpha.1+abc`). Displayed, never parsed.                                                                                         |
| error code     | `^[A-Z][A-Z0-9_]{0,63}$`.                                                                                                                                                         |
| URL            | Absolute `http:` or `https:` URL without user info.                                                                                                                               |
| var name       | `^[A-Za-z_][A-Za-z0-9_]{0,255}$`, and never `__proto__`.                                                                                                                          |
| date           | `YYYY-MM-DD`.                                                                                                                                                                     |
| epoch ms       | Integer milliseconds since the Unix epoch.                                                                                                                                        |

## 5. Messages

`?` marks an optional field.

### 5.1 Box → cloud

**`hello`** — first frame of every connection.

```json
{
    "type": "hello",
    "protocol": 1,
    "boxId": "box_01J9ZK3Q",
    "versions": { "hostd": "1.0.0", "celld": "0.9.2", "caddy": "v2.8.4" },
    "fleets": [{ "alias": "my-app", "deploymentId": "dep_123", "state": "running" }],
    "resources": { "memMb": 3891, "diskFreeMb": 40960 }
}
```

| Field                    | Type                                                 |
| ------------------------ | ---------------------------------------------------- |
| `protocol`               | integer ≥ 1 (§3)                                     |
| `boxId`                  | id                                                   |
| `versions`               | `{hostd, celld, caddy}`, each a version string       |
| `fleets`                 | array, ≤ 500, aliases unique                         |
| `fleets[].alias`         | alias                                                |
| `fleets[].deploymentId`? | id; absent when nothing is deployed into the fleet   |
| `fleets[].state`         | `"running"`, `"stopped"`, `"starting"` or `"failed"` |
| `resources.memMb`        | integer, free memory in MiB                          |
| `resources.diskFreeMb`   | integer, free disk in MiB                            |
| `isolation`?             | `{status, problems?}`; absent before a self-check    |
| `isolation.status`       | `"enforced"`, `"single-trust"` or `"refused"`        |
| `isolation.problems`?    | array, ≤ 8, each ≤ 512 UTF-8 bytes                   |

`isolation` reports the box's fleet-isolation self-check (plan 458 W8;
`apps/hostd/README.md`, "Isolation"): `enforced` when every check passed,
`single-trust` when one failed but the box was enrolled with `--single-trust`
and runs its fleets anyway, `refused` when one failed and the box starts no
fleet (a `deploy` fails with `ISOLATION_FAILED`). `problems` names each failed
check. The field is optional, so a control plane of this version accepts a
`hello` with or without it.

**`auth`** — `{type, signature}`: signature over the challenge payload (§6.1).

**`progress`** — `{type, jobId, line}`: one line of a running job's output,
`line` ≤ 8 KiB.

**`result`** — `{type, jobId, ok, url?, error?}`: the job's outcome. `ok: true`
MUST NOT carry `error`; `ok: false` MUST carry `error: {code, message}`. `url`
(a URL) is the public URL a successful deploy serves on.

**`report`** — `{type, windowStart, windowEnd, perAlias}`: usage over
`[windowStart, windowEnd)`, both epoch ms, `windowEnd ≥ windowStart`.
`perAlias` holds ≤ 500 entries with unique aliases, each
`{alias, requests, errors, p50Ms?}`: integer counts with `errors ≤ requests`,
and `p50Ms` a finite number ≥ 0. Shown in the studio only; never billing
evidence (D12). A box reports once a minute: Lunora Cloud records a window
only when `windowStart` is a whole minute (a multiple of 60 000), spans at most
an hour, is at most a day old and ends no more than five minutes ahead of its
clock, and it records each `windowStart` of a box once — resending a window
(after a reconnect, say) is safe and never double-counts.

**`pong`** — `{type}`.

### 5.2 Cloud → box

**`challenge`** — `{type, nonce}`: sent once per connection after `hello`. The
nonce is single use.

**`job`** — `{type, jobId, job}` where `job` is one of, by `kind`:

| `kind`     | Fields                                                                                                                                  |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `deploy`   | `alias`, `deploymentId` (id), `releaseUrl` (URL), `vars` (object of var name → string), `crons` (string[]), `compatibilityDate`? (date) |
| `destroy`  | `alias`, `deleteData` (boolean)                                                                                                         |
| `reload`   | `alias`                                                                                                                                 |
| `upgrade`  | `releaseId` (id), `manifestUrl` (URL), `allowDowngrade`? (boolean)                                                                      |
| `diagnose` | none                                                                                                                                    |

A job object with an unknown `kind` is rejected. `vars` merges vars and secrets
(D10); `crons` are passed to celld unparsed (D11). `releaseUrl` is fetched with
a signed request (§6.2); a box MUST refuse a `releaseUrl` or `manifestUrl`
whose origin is not the control plane it enrolled with, since it would
otherwise sign requests for a third party.

`upgrade` is **anti-rollback** by default: a box MUST refuse
(`UPGRADE_REFUSED`) a release whose `manifest.hostd.version` is older than the
`lunora-hostd` it has installed, by semantic-version precedence (a pre-release
is older than its release; build metadata is ignored; a version that is not a
semantic version cannot be ordered and is refused too). An old release is
still validly signed, so the signature alone cannot stop a control plane — or
whoever holds its admin token — from rolling a box back onto a release with a
fixed vulnerability. `allowDowngrade: true` lifts the check for that one job;
a control plane sends it only when an operator explicitly asks for a rollback.
A release equal to the installed one is not a downgrade; the release already
running is a no-op.

**`routes`** — `{type, table}`: the full routing table, ≤ 2 000 entries
(§4), each `{hostname, alias}`, hostnames unique.

**`config`** — `{type, telemetry?}`: the box's runtime configuration (plan 458
W6). `telemetry` is `{endpoint, token}`: `endpoint` (URL) is an OTLP/HTTP base
and `token` (1–512 printable ASCII characters, no spaces) the organization's
ingest key. With it, the box forwards its own logs — hostd's warnings and
errors, each celld node's stderr, Caddy's warnings and errors — as OTLP/JSON
log records, `POST {endpoint}/v1/logs` with `Authorization: Bearer {token}`;
without it, it forwards nothing. Each record carries the attributes `box` (the
box's slug, the first label of its hostname), `source` (`hostd`, `celld` or
`caddy`) and, for a fleet's line, `alias`; the resource's `service.name` is the
alias for a fleet's line and `lunora-hostd` otherwise. A box holds the token in
memory only and never logs it, buffers a bounded number of records (dropping
the oldest), redacts known secrets before sending, and does not send the token
to a plain-`http:` endpoint unless its control plane is plain `http:` itself
(a development setup).

```json
{ "type": "config", "telemetry": { "endpoint": "https://api.lunora.sh", "token": "production:org_8f3a|…" } }
```

**`ping`** — `{type}`.

**`error`** — `{type, code, message}`: the control plane refuses the box and
closes. Shape frozen across versions (§3). Codes in use:

| Code                   | When                                                       |
| ---------------------- | ---------------------------------------------------------- |
| `PROTOCOL_UNSUPPORTED` | `hello.protocol` is not a version the control plane speaks |
| `AUTH_FAILED`          | the `auth` signature does not verify                       |
| `BOX_REVOKED`          | the box's key has been revoked                             |
| `BAD_MESSAGE`          | the box sent a frame the control plane rejected            |
| `RATE_LIMITED`         | the box sent frames faster than its per-socket budget      |
| `TIMEOUT`              | the box sent nothing for 90 seconds                        |
| `SUPERSEDED`           | a newer session of the same box authenticated              |
| `UNAVAILABLE`          | the control plane cannot accept boxes right now            |

A box MUST treat an unknown code as a refusal too.

## 6. Signing

Both payloads are signed with **Ed25519** (RFC 8032, pure, no pre-hash) using
the private key the box generated at enrolment (D4). The signature is sent as
base64url without padding (86 characters). The payloads are UTF-8 byte strings,
each starting with its own domain tag, so a signature made for one purpose can
never be replayed as the other.

### 6.1 Challenge (`auth`)

```text
lunora-hostd-auth:v1:{boxId}:{nonce}
```

`:` is unambiguous because neither an id nor a base64url nonce can contain it.
Example (from the fixtures): `lunora-hostd-auth:v1:box_01J9ZK3Q:c2VydmVyLW5vbmNlLTEyOC1iaXRz`.

Timestamps are deliberately absent: the server's single-use nonce gives replay
protection without making a box with a skewed clock fail closed (D4).

### 6.2 Signed HTTP request (release fetch, D6)

Six lines joined by `\n` (0x0A), no trailing newline:

```text
lunora-hostd-request:v1
{method}
{path}
{boxId}
{timestamp}
{nonce}
```

| Field       | Format                                                                                                |
| ----------- | ----------------------------------------------------------------------------------------------------- |
| `method`    | upper-case HTTP method, e.g. `GET`                                                                    |
| `path`      | origin-form request target: `/`, then printable ASCII without spaces or `#` (query included), ≤ 2 048 |
| `boxId`     | id                                                                                                    |
| `timestamp` | epoch ms in decimal; required                                                                         |
| `nonce`     | 22–128 base64url characters, chosen by the box, unique per request                                    |

The fields travel in headers:

| Header                   | Value         |
| ------------------------ | ------------- |
| `x-lunora-box-id`        | `boxId`       |
| `x-lunora-box-nonce`     | `nonce`       |
| `x-lunora-box-timestamp` | `timestamp`   |
| `x-lunora-box-signature` | the signature |

The server rebuilds the payload from the request it received and verifies the
signature against the box's enrolled public key. It MUST refuse a request
without a timestamp, one whose timestamp is more than five minutes from its own
clock, and a nonce it has already accepted for that box within that window.

Unlike the challenge (§6.1), a signed request is not bound to a live session,
so the timestamp is mandatory: without it a captured request stays valid for
as long as the box's key does, and the nonce alone protects it only while the
server still remembers it. A box keeps its clock synchronised (NTP); a box
whose clock is more than five minutes off cannot fetch releases until it is.

## 7. Conformance

An implementation conforms when, against `fixtures/messages.json`:

1. every frame under `box` and `cloud` decodes to an object equal to it, and
   encoding that object decodes back to the same object;
2. every case under `invalid.box` / `invalid.cloud` is rejected with the given
   `code` (and `path`, where the fixture gives one);
3. the signing payloads it builds from the `signing` inputs equal `payload`
   byte for byte;
4. frames over the caps in §4 are rejected (generated by the test suite, not
   stored in the fixtures).

## 8. Release manifest

A release is the set of binaries a box installs: `hostd`, celld and Caddy, one
artifact per platform each. An `upgrade` job names it by `releaseId` and points
at its signed manifest with `manifestUrl` (§5.2); `install.sh` starts from the
same file. Reference implementation: `@lunora/hostd/release` (types, validator,
canonical bytes and signature verification on WebCrypto; runs in Node and
workerd alike) and `@lunora/hostd/release/verify` (signing and artifact
hashing; Node only).

### 8.1 Envelope

The published file (`manifest.json`, a GitHub Release asset of
`hostd-v<version>`) is one JSON object:

```json
{
    "keyId": "ed25519-0d1e602e43d4c12c",
    "manifest": {
        "schema": 1,
        "releaseId": "hostd-v1_0_0",
        "createdAt": "2026-10-02T12:00:00.000Z",
        "hostd": {
            "version": "1.0.0",
            "artifacts": [
                {
                    "platform": "linux-x64",
                    "url": "https://github.com/anolilab/lunora/releases/download/hostd-v1.0.0/lunora-hostd-linux-x64",
                    "sha256": "<64 hex>",
                    "size": 123538624
                }
            ]
        },
        "celld": {
            "version": "v0.6.0",
            "artifacts": [
                {
                    "platform": "linux-x64",
                    "url": "https://github.com/denoland/celld/releases/download/v0.6.0/celld-x86_64-unknown-linux-gnu.gz",
                    "sha256": "8f1e18072c234ab75459d4da104c13cebc9b29a3e4a4772086bf985829bea8aa",
                    "size": 25031703,
                    "compression": "gzip"
                }
            ]
        },
        "caddy": { "version": "v2.11.6", "modules": ["github.com/mholt/caddy-ratelimit"], "artifacts": ["…"] }
    },
    "signature": "<86 base64url characters>"
}
```

| Field                                  | Format                                                                                                  |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `keyId`                                | `^[A-Za-z0-9_.-]{1,64}$`; for Lunora's keys `ed25519-` + first 16 hex digits of SHA-256(raw public key) |
| `signature`                            | Ed25519 signature, base64url without padding (86 characters), over §8.2                                 |
| `manifest.schema`                      | `1`                                                                                                     |
| `manifest.releaseId`                   | id (§4.1), so it travels unchanged in an `upgrade` job                                                  |
| `manifest.createdAt`                   | UTC `YYYY-MM-DDTHH:MM:SS[.sss]Z`, a real date                                                           |
| `manifest.{hostd,celld,caddy}.version` | version string (§4.1)                                                                                   |
| `manifest.caddy.modules`               | ≤ 16 unique Go module paths (`host/path…`, ≤ 256 characters)                                            |
| `…artifacts`                           | 1–2 entries, platforms unique; all three components cover the **same** platforms                        |
| `…artifacts[].platform`                | `"linux-x64"` or `"linux-arm64"`                                                                        |
| `…artifacts[].url`                     | absolute `https:` URL, no user info, ≤ 2 048 characters, printable ASCII without space, `"` or `\`      |
| `…artifacts[].sha256`                  | 64 **lowercase** hex digits: SHA-256 of the bytes at `url`                                              |
| `…artifacts[].size`                    | integer ≥ 1: byte length of the bytes at `url`                                                          |
| `…artifacts[].compression`?            | `"gzip"`: the bytes at `url` are a gzip stream of the binary. Hash and size are of the download         |

Validation is strict as in §4: an unknown field anywhere rejects the file.
`hostd` and `caddy` artifacts are built by Lunora's release workflow (Caddy with
xcaddy, from a pinned Caddy version and module commits, gzipped) and published on
the same GitHub Release; `celld` artifacts pin upstream release assets by
checksum.

### 8.2 Signed bytes

```text
lunora-hostd-release:v1\n{canonical manifest}
```

The domain tag, one newline (0x0A), then the **canonical** encoding of
`manifest`: JSON with every object's keys sorted by code point (all keys are
ASCII, so byte order), no whitespace anywhere, array order kept, integers in
plain decimal. Every string in a valid manifest is printable ASCII without `"`
or `\`, so no string needs a JSON escape and every JSON library produces the
same bytes. The signature is pure Ed25519 (RFC 8032, no pre-hash) over those
bytes.

A box therefore never trusts the bytes as they were sent: it parses, validates,
re-encodes canonically and verifies that. With `jq` and OpenSSL 3:

```sh
{ printf 'lunora-hostd-release:v1\n'; jq -cjS .manifest manifest.json; } > payload
jq -r .signature manifest.json | tr '_-' '/+' | sed -e 's/$/==/' | base64 -d > signature
openssl pkeyutl -verify -pubin -inkey release-key.pem -rawin -in payload -sigfile signature
```

(`jq -S` sorts keys by code point and `-c` drops whitespace; the 86-character
signature needs exactly `==` of padding before standard base64 decoding.)

### 8.3 Verifying a release

A box (and the control plane, before it offers a release):

1. MUST validate the envelope strictly (§8.1).
2. MUST look `keyId` up in the release keys **compiled into its own binary**
   (`HOSTD_TRUSTED_RELEASE_KEYS`) and refuse an unknown key. A key is never
   fetched or taken from the envelope.
3. MUST verify `signature` over §8.2 with that key.
4. For an `upgrade` job, MUST refuse a manifest whose `releaseId` differs from
   the job's, and one whose `hostd.version` is older than the installed
   `lunora-hostd` unless the job sets `allowDowngrade` (§5.2).
5. MUST check each artifact it installs against `size`, then `sha256`, before
   decompressing or executing it, and refuse any mismatch.

Key rotation adds the new key to the compiled-in set in a release signed by a
key boxes already trust; a key is removed only once no supported `hostd` pins
it. GitHub artifact attestations (`gh attestation verify`) prove where an
artifact was built; they are for auditors, and a box does not depend on them.
