# Plan 086 — Tagged value codec for the RPC/WS transport (Cap'n Web-style)

> **Source:** Wave 9 competitive/protocol analysis vs. Cloudflare **Cap'n Web**
> (`cloudflare/capnweb`) and its PR **#201** (ArrayBuffer + typed-array
> serialization). The gap: Lunora's transport is bare `JSON.stringify` /
> `JSON.parse` in both directions, so schema value-kinds that JSON cannot
> represent (`v.bytes()` → `ArrayBuffer`, `v.bigint()` → `bigint`) — and the
> **decoded** custom scalars from **plan 078** — cannot round-trip as RPC
> args/results or subscription rows. This plan adds the **transport-layer** half
> of value fidelity; 078 is the **storage-layer** half (they compose).
>
> All code anchors are at HEAD (`advisor/wave-8`); re-verify before trusting.

## 0. The gap, first-hand

The wire is untyped JSON with **no reviver / replacer** on either side:

| Boundary            | Anchor                                       | Code (verbatim)                                          |
| ------------------- | -------------------------------------------- | -------------------------------------------------------- |
| Client → server RPC | `packages/client/src/lunora-client.ts:2927`  | `body: JSON.stringify({ args, functionPath, shardKey })` |
| Server ingest       | `packages/runtime/src/create-worker.ts:1205` | `body = JSON.parse(text)`                                |
| Server → client RPC | `packages/client/src/lunora-client.ts:2943`  | `body = await response.json()`                           |
| Server → client WS  | `packages/client/src/lunora-client.ts:3424`  | `message = JSON.parse(text) as ServerMessage`            |

Meanwhile `@lunora/values` **defines** value-kinds JSON cannot carry:

- `v.bigint()` — `packages/values/src/v.ts:459` (a real `bigint`). `JSON.stringify(1n)` **throws** (`TypeError: Do not know how to serialize a BigInt`). So a mutation arg or query result typed `v.bigint()` throws on the client before it ever leaves.
- `v.bytes()` — `packages/values/src/v.ts:481` (an `ArrayBuffer`). `JSON.stringify(new ArrayBuffer(8))` silently produces `{}`. So a `bytes` column read back through a subscription/query **arrives as `{}`** — silent data loss, not an error.

**Out of scope (already fine):** `v.date()` / `v.timestamp()` schema to an
**epoch-ms integer** (`packages/values/src/json-schema-core.ts:73`), so they are
numbers on the wire and survive round-trip unchanged. No codec needed for them.

### Why 078 does not already cover this

Plan 078's codec is the **app-type ↔ SQLite-affinity** hop (`encode`/`decode`
run in `ctx-db.ts` at the storage boundary; §3 rows 5–6). After `decode`, the row
holds an `ArrayBuffer` / `Float32Array` and then **enters the JSON path** — where
it collapses to `{}` exactly like `v.bytes()` above. 078 gets the value out of
SQLite; it does **not** get it across the socket. This plan is the missing
transport codec that 078's decoded scalars need to reach the client. Ship order:
086 unblocks 078's binary custom scalars end-to-end.

## 1. What Cap'n Web does (the design we borrow)

Cap'n Web keeps the wire **human-readable JSON** but reserves arrays as
type-tagged expressions (everything else is literal). The relevant tags:

- `["bigint", "123456"]` — bigint as a decimal string.
- `["bytes", "<base64>"]` — `Uint8Array`. **PR #201** extends this to
  `["bytes", "<base64>", "Float32Array"]` for `ArrayBuffer` and every typed-array
  view, keeping the 2-element form back-compatible for `Uint8Array`. PR #201's
  stated motivators are **email attachments** and **AI Search** — the same
  surfaces Lunora has in `@lunora/mail` and `@lunora/ai`.
- `["date", 1749342170815]`, `["undefined"]`, `["nan"]`, `["inf"]`, `["-inf"]`.
- `["error", name, message, stack?, props?]` — deferred to **plan 087**.

We adopt the **encoding scheme**, not the protocol. Lunora's `RpcEnvelope`
(fan-out, merge, shard key, CDC cursor, watermarks) is a domain protocol Cap'n
Web has no concept of; we are only upgrading how leaf **values** inside `args`,
`result`, and subscription `data`/`delta`/`RowOp.value` are encoded.

## 2. Scope — exactly which leaves get encoded

Encode only the value-kinds JSON drops or corrupts:

| App type                                    | Wire form                           | Note                               |
| ------------------------------------------- | ----------------------------------- | ---------------------------------- |
| `bigint`                                    | `["bigint", "<decimal>"]`           | matches `v.bigint()`               |
| `ArrayBuffer`                               | `["bytes", "<b64>", "ArrayBuffer"]` | matches `v.bytes()`; PR #201 shape |
| `Uint8Array`                                | `["bytes", "<b64>"]`                | 2-arg back-compat form             |
| other typed-array views (`Float32Array`, …) | `["bytes", "<b64>", "<Ctor>"]`      | needed by 078 `vector()` scalars   |
| `undefined` (in arrays / as a value)        | `["undefined"]`                     | today lost or coerced to `null`    |
| `NaN`/`±Infinity`                           | `["nan"]`/`["inf"]`/`["-inf"]`      | today become `null`                |

**Explicitly NOT encoded** (parity with Cap'n Web's own limits, keeps the codec
tiny and the security surface small): `Map`, `Set`, `RegExp`, cyclic graphs,
class instances, functions, `RpcTarget`-style capabilities (see 088 §fence).
`Date` stays a plain epoch-ms number per §0.

**Ambiguity fence — the escaping rule.** Because a bare JSON array is now
significant, a _user array whose first element is a string matching a tag_ must
be escaped so it round-trips. Cap'n Web solves this by wrapping a literal array
one level (`[[ ... ]]` — the inner array is the literal). Adopt the same rule and
put it under test; this is the single subtlest correctness point of the codec.

## 3. Where it plugs in (all anchored)

A single dependency-free codec pair, inlined like `shared/stable-key.ts` (same
no-coupling rationale: `@lunora/client` is a standalone browser bundle,
`@lunora/do` is a leaf server runtime — no shared package to host it):

| #   | Concern                 | File / anchor                                                   | Change                                                                                                                                                                                     |
| --- | ----------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | Codec                   | new `shared/wire-codec.ts`                                      | `encodeWire(value)` / `decodeWire(value)` — pure, recursive, zero-dep. Base64 via `Uint8Array`↔binary-string (no Node `Buffer`).                                                           |
| 2   | Client RPC send         | `packages/client/src/lunora-client.ts:2927`                     | `JSON.stringify({ args: encodeWire(args), functionPath, shardKey })`.                                                                                                                      |
| 3   | Client RPC result       | `packages/client/src/lunora-client.ts:2969`                     | `return decodeWire(body.result)`.                                                                                                                                                          |
| 4   | Client WS parse         | `packages/client/src/lunora-client.ts:3424`                     | run `decodeWire` over `data`/`delta` and each `RowOp.value` in poke frames (not over control fields like `id`/`cursor`/`epoch`).                                                           |
| 5   | Server ingest           | `packages/runtime/src/create-worker.ts:1205`                    | after parse, `envelope.args = decodeWire(envelope.args)` before validation/dispatch.                                                                                                       |
| 6   | Server RPC/WS emit (DO) | `packages/do/src/shard-do.ts` (RPC response + poke/delta build) | `encodeWire` the `result` and subscription row values before `JSON.stringify`. Reuse the same shared file (bundler-inlined).                                                               |
| 7   | Dedup-key parity        | `shared/stable-key.ts`                                          | `stableStringify` must produce a stable key for the new kinds too (a `bytes` arg must dedup consistently). Add cases; do **not** merge codecs (different contracts — see the file header). |

**Validation ordering (critical):** `decodeWire` runs **before** `validateArgs`
(`packages/server/src/functions.ts:15`). The validator then sees a real
`ArrayBuffer`/`bigint` and `v.bytes()`/`v.bigint()` accept it — otherwise every
binary/bigint arg fails validation. Symmetrically, encode runs **after** the
handler returns, on the outbound result.

## 4. Interaction with plan 078

078 registers per-column `encode`/`decode` for the **SQLite affinity**. This plan
adds `encodeWire`/`decodeWire` for the **socket**. A 078 `vector(1536)` column:
`BLOB (storage) --078.decode--> Float32Array (in DO memory) --086.encodeWire-->
["bytes", b64, "Float32Array"] (wire) --086.decodeWire--> Float32Array (client)`.
Neither codec knows about the other; they compose because 086 keys off the
runtime JS type, not the schema. **086 should land before 078's binary path is
advertised** or 078's synced custom scalars silently `{}`-truncate.

## 5. Security & limits

- **DoS / allocation:** base64 payloads inflate ~33%; a hostile client could send
  a huge `["bytes", ...]`. The existing body-size limits (`readJsonBodyWithLimit`
  / `readBodyTextWithLimit`, runtime) still bound the raw JSON, so this adds no
  new unbounded path — but add a per-value decoded-byte cap and reject over it.
- **No capabilities.** The codec has no `["import"]`/`["export"]`/`["promise"]`
  tags — Lunora does not pass references. This is deliberate (see 088 §fence):
  capability tables are incompatible with DO hibernation.
- **Runtime validation unchanged.** Decoding produces a typed value; `v.*` still
  validates it. Cap'n Web's "no runtime type checking" caveat does not apply —
  Lunora validates every arg (`validateArgs`), which is a strength to preserve.

## 6. Verification plan

1. `shared/wire-codec.ts` unit tests: round-trip each kind; the escaping rule
   (`["bigint","1"]` as a _literal user array_ survives); nested in objects and
   arrays; `undefined`-in-array vs object-field parity; decoded-byte cap rejects.
2. `@lunora/values`: a function with `args: { blob: v.bytes(), big: v.bigint() }`
   and a `returns` of the same — end-to-end encode→validate→handler→encode→decode.
3. `@lunora/do` (workerd gate `LUNORA_WORKERD_TESTS=1`): a `v.bytes()` column
   read via query **and** via a live subscription delta arrives as an equal
   `ArrayBuffer` (today: `{}`). Regression-guards the silent-truncation bug.
4. Back-compat: a plain-JSON client (pre-codec) talking to a codec server, and
   vice versa, for **payloads with no special kinds**, must be byte-identical
   (the codec is a no-op on pure-JSON values). Assert this — it makes rollout safe.
5. `stableStringify` parity test (row 7).

## 7. Effort & risk

**S–M.** One ~80-line codec file + six wiring points + key-parity. Risk
concentrates in (a) the escaping rule and (b) getting encode/decode on the
**correct side** of `validateArgs`. No protocol/envelope change, no new dep, no
codegen change. Fully back-compatible on pure-JSON payloads (§6.4), so it can
ship dark and be exercised only when a `bytes`/`bigint` value actually appears.

## 7a. Phase status (branch `feat/capnweb-wire-fidelity`)

- **Phase 1 — RPC path: DONE.** `shared/wire-codec.ts` + client encode-args/decode-result
    - DO decode-args-for-handler / encode-result-once (idempotency-cache stores the
      wire form, so replays never double-encode). Pure-JSON payloads stay byte-identical.
      Unit + integration tests green; client/server/DO suites unregressed.
- **Phase 2 — subscription/poke frames: TODO (benchmark-gated).** The reactive
  delta path (`subscription-delivery.ts` `collectUpsertDeltas`) builds each frame by
  **string-concatenating a single `JSON.stringify(nextRow)`** — the finding-#6 / #072
  optimization. A `v.bytes()` row there still truncates to `{}` and a `v.bigint()`
  row throws. Fixing it means either (a) a `containsWireSpecial(row)` guard + a second
  `encodeWire` walk (regresses the hottest path for normal rows — the exact path prior
  waves tuned) or (b) a `JSON.stringify(row, replacer)` that tags leaves in the single
  walk (the `"arr"` escape is awkward inside a replacer). Both want a micro-benchmark
  before landing, so this is deliberately a separate phase, not folded into Phase 1.
  The client half is small (decode `data`/`delta`/`rowsPatch[].value`/chunk/whisper in
  `handleServerMessage`) and is a safe no-op until the server encodes — add it with Phase 2.

## 8. Open decisions

1. **Roll-out ordering vs 078** — recommend 086 first (078's binary scalars
   depend on it). Confirm 078 hasn't shipped its binary path yet.
2. **Where the codec lives** — `shared/` (bundler-inlined, recommended, matches
   `stable-key.ts`) vs a tiny `@lunora/values` subpath export. `shared/` avoids a
   client→values runtime edge.
3. **Encode-everything vs. encode-on-demand** — always run `encodeWire` (simple,
   O(n) walk) vs. skip the walk when a fast scan finds no special types. Recommend
   always-run for correctness; measure before optimizing (values payloads are
   already small; the walk is cheap vs. the network hop).
4. **Typed-array breadth** — encode all nine view constructors, or only
   `ArrayBuffer` + `Uint8Array` + `Float32Array` (what `v.bytes()` and 078
   realistically produce)? Recommend the full set (PR #201 does) — trivial and
   future-proofs 078.
