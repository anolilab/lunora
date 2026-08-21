# Plan 449: Decide how the offline mutation outbox serializes caller args

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. Your reviewer maintains `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 207be1b63..HEAD -- packages/client/src/async-storage-persistence.ts packages/client/src/single-blob-store.ts packages/client/src/async-storage-query-cache.ts packages/client/src/lunora-client.ts shared/wire-codec.ts`
> If any changed since this plan was written, compare the "Current state"
> excerpts against the live code before proceeding; on a mismatch, treat it as
> a STOP condition.
>
> **This plan assumes PR [#440](https://github.com/anolilab/lunora/pull/440)
> (`improve/wave22-client`) has merged** — it introduced `single-blob-store.ts`
> and `async-storage-query-cache.ts`, which this plan builds on. If `ls
packages/client/src/single-blob-store.ts` does not exist, stop and wait.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: MED
- **Depends on**: PR #440 (wave-22 client work) merged to `alpha`
- **Category**: bug
- **Planned at**: commit `1699f4317`, 2026-08-21

## Why this matters

`createAsyncStoragePersistence` — the React Native / Expo durable **write** outbox —
round-trips queued mutations through raw `JSON.stringify` / `JSON.parse`. A caller who
does this while offline:

```ts
client.mutation(api.payments.charge, { amount: 1n });
```

hits `JSON.stringify(1n)`, which **throws** `TypeError: Do not know how to serialize a
BigInt`. The rejection surfaces via `onPersistenceError` with `operation: "append"`,
and the documented consequence (`packages/client/src/types.ts:121-123`) is:

> Note: a failed `append` means the write is queued in memory but NOT durable — it
> will not survive a reload.

So the write flushes fine if the app stays open, and is **silently lost on reload** if
it does not. Worse, values JSON _degrades_ rather than rejecting — a `Date` becomes a
string, a `Map`/`Set` becomes `{}`, `NaN`/`Infinity` become `null` — replay after a
reload with mangled args and no error at all.

The read-cache sibling was fixed for exactly this in wave 22
(`async-storage-query-cache.ts`, PR #440). The outbox was **deliberately** left alone,
and the reason is written into that file's docblock:

> (This is what separates the read cache from the outbox, which stores JSON-safe args
> the caller chose.)

That sentence is the assumption this plan exists to test. It is not obviously true —
nothing in the client's API says outbox args must be JSON-safe, and the transport
happily carries `bigint`.

## Current state

### The outbox adapter (post-#440), `packages/client/src/async-storage-persistence.ts`

```ts
const createAsyncStoragePersistence = (options: AsyncStoragePersistenceOptions): PersistenceAdapter => {
    const blob = singleBlobStore(options.storage, options.key ?? DEFAULT_KEY);

    const readAll = async (): Promise<PersistedMutation[]> => {
        const parsed = await blob.read();

        return Array.isArray(parsed) ? (parsed as PersistedMutation[]) : [];
    };

    return {
        append: (mutation) =>
            blob.serialize(async () => {
                const mutations = await readAll();
                mutations.push(mutation);
                await blob.write(mutations);
            }),
        // …clear / load / remove…
    };
};
```

`singleBlobStore` is raw JSON on both sides (`packages/client/src/single-blob-store.ts`):

```ts
read: async () => {
    const raw = await storage.getItem(key);
    if (raw === null) return undefined;
    try { return JSON.parse(raw) as unknown; } catch { return undefined; }
},
write: (value) => storage.setItem(key, JSON.stringify(value)),
```

### The read-cache sibling, `packages/client/src/async-storage-query-cache.ts`

```ts
const readAll = async (): Promise<Map<string, StoredQuery>> => {
    const parsed = decodeWire(await blob.read());
    // …
};

const writeAll = (entries: Map<string, StoredQuery>): Promise<void> => blob.write(encodeWire(Object.fromEntries(entries)));
```

Note the shape: the **adapter** encodes/decodes; `singleBlobStore` stays raw. That is
the seam this plan should reuse, whichever option is chosen.

### What `encodeWire` does and does not accept — `shared/wire-codec.ts`

- Tags the leaves plain JSON cannot carry: `bigint`, `Date`, `Error`, `URL`, `Map`,
  `Set`, `ArrayBuffer`/typed arrays, `NaN`/`Infinity`, array-position `undefined`.
- **Throws** `TypeError` on any remaining non-plain object (`wire-codec.ts:270-280`):
  a `RegExp`, `Headers`, a class instance, a function. "Plain" means an
  `Object.prototype` or null-prototype object; arrays fall through separately.
- Throws `RangeError` past a `MAX_DEPTH` nesting cap.
- Is the identity for JSON-safe data (`lunora-client.ts:1572` records this).

### The decisive fact: the flush path **already** rejects the same values

`packages/client/src/lunora-client.ts:5896-5919`:

```ts
/**
 * Partition already-gated writes into the encodable ones (returned) and reject
 * the rest terminally. A write whose args can't be wire-encoded (e.g. a RegExp
 * or class instance in a `v.any()` field) can NEVER replay — the codec failure
 * is deterministic, not transient. …
 */
private encodableOrSettleTerminal(items: QueuedMutation[]): QueuedMutation[] {
    for (const item of items) {
        try {
            encodeCallArgs(item.args, `args for '${item.functionPath}'`);
            encodable.push(item);
        } catch (error) {
            this.settleReplayTerminal(item, error instanceof Error ? error : new Error(String(error)));
        }
    }
    // …
}
```

And every send path encodes: `service.ts:140` (`args: encodeWire(args ?? {})`),
`lunora-client.ts:670` (`encodeCallArgs`), `lunora-client.ts:5044`.

**Therefore a queued write whose args fail `encodeWire` is already doomed** — the
client rejects it deterministically at flush. Encoding at the persistence boundary
does not make anything newly un-queueable; it moves an existing rejection earlier and
gives it a clearer message.

### The current per-adapter inconsistency

| Adapter                         | Backing                      | `{ amount: 1n }` today                     |
| ------------------------------- | ---------------------------- | ------------------------------------------ |
| `createIndexedDbPersistence`    | IndexedDB (structured clone) | persists fine — clone handles `bigint`     |
| `createAsyncStoragePersistence` | JSON                         | `append` **rejects**; write lost on reload |
| in-memory persistence           | structural clone             | persists fine                              |

Durability of a caller's write depends on which storage backend they configured. That
is the bug, stated without reference to any single value type.

## Existing seams (do not reinvent)

- **`encodeWire` / `decodeWire`** (`shared/wire-codec.ts`, imported as
  `../../../shared/wire-codec`) — already a client dependency, already used on every
  send path and in the sibling cache adapter.
- **`async-storage-query-cache.ts`'s encode-at-the-adapter pattern** — the exact shape
  to copy. Do **not** push encoding down into `singleBlobStore`; it is shared, and the
  cache adapter would then double-encode.
- **`encodeCallArgs`** (`lunora-client.ts:668-681`) — wraps a codec failure with the
  call it came from ("cannot encode args for 'messages:send' — …"). If the chosen
  option encodes, reuse this labelling rather than surfacing a bare codec error. It is
  currently `private`/module-scoped; check before assuming it can be imported.
- **`onPersistenceError`** (`types.ts:107-127`) — the existing, documented channel for
  a persistence failure. No new error surface is needed.

## The behavioural contract to preserve

1. **`PersistedMutation`'s full shape must survive a round trip.** PR #440 added
   `packages/client/__tests__/persistence.test.ts` assertions for exactly this
   (plan 398), after the in-memory adapter was found dropping `clientId` and `version`.
2. **FIFO order.** `load()` returns mutations in enqueue order.
3. **`load()` must not alias.** Callers get freshly-parsed records.
4. **A corrupt payload starts clean, it does not wedge.** `singleBlobStore.read`
   returns `undefined` on a parse failure; whatever is added must keep that property —
   a `decodeWire` throw on a corrupt blob must not make every `load()` fail forever.
   (`wire-codec.ts:462-466` notes `decodeWire`'s callers "are read paths that must
   degrade rather than [throw]" — check whether that applies to the exported
   `decodeWire` or only to a `safe*` variant, and handle it explicitly.)
5. **The other two persistence adapters are unchanged.**

## The options

### Option A — Encode through the wire codec; accept the stricter rejection

`append` writes `encodeWire(mutation)`; `load` reads `decodeWire(...)`.

- **Gains**: `bigint`, `Date`, `Map`/`Set`, bytes, `NaN`/`Infinity` all become durable.
  Closes the per-adapter inconsistency — AsyncStorage matches IndexedDB.
- **Cost**: `append` now _throws_ on a `RegExp` / class instance where JSON silently
  produced `{}`. On paper a behaviour change.
- **Why the cost is near-zero in practice**: `encodableOrSettleTerminal` already
  rejects those exact values terminally at flush. Today they are persisted as
  garbage and then rejected on replay; under A they are rejected at enqueue with a
  better message. Nothing that could ever have succeeded stops succeeding.
- **Residual risk**: the failure moves from replay-time to enqueue-time. An app whose
  `onPersistenceError` handler was never exercised will start seeing it.

### Option B — Encode, with a documented fallback to raw JSON on codec failure

`try { blob.write(encodeWire(...)) } catch { blob.write(JSON.stringify-able subset) }`.

- **Gains**: strictly additive; nothing that persists today stops persisting.
- **Cost**: two serialization formats in one blob, so `load` must sniff which it is
  reading. That is a second mechanism beside a working one, and it makes the
  round-trip contract conditional — "your args survive, unless they didn't, in which
  case they were mangled and you were not told". It preserves precisely the silent
  degradation that makes the current behaviour a bug.
- **Assessment**: rejected. The fallback's only beneficiary is a write the flush path
  will terminally reject anyway.

### Option C — Keep JSON; document the limitation loudly at the API boundary

Add an explicit constraint to `createAsyncStoragePersistence`'s docblock and to
`PersistenceAdapter`/`OfflineQueueOptions`: outbox args must be JSON-safe on this
adapter, and non-JSON-safe args are dropped or rejected.

- **Gains**: zero behaviour change; smallest possible diff.
- **Cost**: the inconsistency stays. A caller must know which persistence adapter they
  configured to know whether `{ amount: 1n }` is durable. The `Date`-to-string and
  `Map`-to-`{}` silent manglings stay silent — documentation does not make a wrong
  replay visible.
- **Assessment**: acceptable only if Option A turns out to break something real.

### Recommendation: **Option A**

The "stricter rejection" objection does not survive contact with
`encodableOrSettleTerminal`. Option A makes the AsyncStorage adapter behave like its
two siblings, deletes a class of silent data corruption, and adds no new mechanism —
it copies the one the sibling cache adapter already uses, four files over.

## Design decisions

**D1 — Encode at the adapter, not in `singleBlobStore`.** `singleBlobStore` is shared
with `async-storage-query-cache.ts`, which already encodes; pushing encoding down
would double-encode the cache. This also matches the existing file's own comment that
`read`/`write` are "raw (no locking)" primitives.

**D2 — Encode the whole `PersistedMutation`, not just `.args`.** Simpler, and it
covers `identity` and any future field with the same property. `encodeWire` is the
identity for JSON-safe data, so the stored blob for a normal app is byte-identical to
today's.

**D3 — Keep `decodeWire` failures degrading, not throwing.** Contract point 4. A blob
written by an older app version is plain JSON; `decodeWire` must return it unchanged
(it should — untagged JSON has no tags to decode), and a genuinely corrupt blob must
still read as "start clean". Assert both.

**D4 — Do not change the IndexedDB or in-memory adapters.** They already round-trip
via structured clone / structural clone. Touching them is out of scope.

## Commands you will need

| Purpose    | Command                                          | Expected on success |
| ---------- | ------------------------------------------------ | ------------------- |
| Install    | `pnpm install`                                   | exit 0              |
| Build deps | `pnpm --filter "@lunora/client..." run build`    | exit 0              |
| Tests      | `pnpm --filter "@lunora/client" run test`        | all pass            |
| Typecheck  | `pnpm --filter "@lunora/client" run lint:types`  | exit 0              |
| Lint       | `pnpm --filter "@lunora/client" run lint:eslint` | exit 0              |
| API check  | `pnpm run api:check`                             | exit 0              |

## Scope

**In scope**:

- `packages/client/src/async-storage-persistence.ts`
- `packages/client/__tests__/persistence.test.ts` (the outbox round-trip suite)
- Possibly `packages/client/src/types.ts` — a docblock line on `OfflineQueueOptions`
  saying args are wire-encoded, if the change warrants it

**Out of scope**:

- `packages/client/src/single-blob-store.ts` — see D1
- `packages/client/src/async-storage-query-cache.ts` — already correct
- The IndexedDB and in-memory persistence adapters — see D4
- `packages/client/src/lunora-client.ts` — the flush-path gate is correct as-is
- `shared/wire-codec.ts`

## Git workflow

- Branch: `improve/followup-client-outbox-codec`
- Commit: `fix(client): encode the offline outbox through wire` (50 chars)
- The commit body must state that non-wire-encodable args now reject at `append`
  instead of persisting mangled, and note that the flush path already rejected them.

## Steps

### Step 1: Prove the current failure

Add a test to `packages/client/__tests__/persistence.test.ts` using the in-file
AsyncStorage double: `append` a `PersistedMutation` whose `args` are `{ amount: 1n }`,
then `load` and assert `amount === 1n`.

**Verify**: `pnpm --filter "@lunora/client" run test -- persistence` → the new test
FAILS (the `append` promise rejects with a BigInt `TypeError`). If it passes, STOP —
the premise is wrong.

Add a second failing case with `{ when: new Date(0) }` asserting `load()` returns a
`Date`, not a string. This one proves the _silent_ half of the bug.

### Step 2: Encode at the adapter

In `packages/client/src/async-storage-persistence.ts`, mirror
`async-storage-query-cache.ts`: `decodeWire` in `readAll`, `encodeWire` in the write.
Import from `../../../shared/wire-codec` exactly as the sibling does.

Replace the "The whole FIFO mutation log is serialized to JSON under a single key"
sentence in the docblock — it will no longer be true. State that values pass through
the wire codec, why (the outbox holds caller args, which the transport already carries
as tagged wire values), and that a non-encodable value now rejects at `append` rather
than persisting mangled — cross-referencing `encodableOrSettleTerminal`, which
rejects the same values at flush.

Also correct the now-false sentence in `async-storage-query-cache.ts`'s docblock:
"(This is what separates the read cache from the outbox, which stores JSON-safe args
the caller chose.)" — that distinction no longer holds. This is the one edit permitted
in that otherwise out-of-scope file.

**Verify**: `pnpm --filter "@lunora/client" run test -- persistence` → the two Step 1
tests pass.

### Step 3: Prove the degradation contract still holds (D3)

Add three tests:

1. **Legacy blob.** Pre-seed the storage double with plain `JSON.stringify([mutation])`
   (no wire tags), then `load()` → returns the mutation intact. This is the
   upgrade-in-place path for an app that already has a queue on disk.
2. **Corrupt blob.** Pre-seed with `"{not json"` → `load()` returns `[]`, does not
   throw, and a subsequent `append` + `load` works.
3. **Non-encodable args reject.** `append` with `args: { re: /x/ }` → the promise
   rejects; assert the error message names the offending type. Then assert `load()`
   still returns the previously-queued mutations (one bad append must not corrupt the
   blob — check the read-modify-write order carefully, since `blob.write` is only
   reached after `encodeWire` succeeds).

**Verify**: `pnpm --filter "@lunora/client" run test` → all pass.

### Step 4: Confirm the full-shape and FIFO contracts survive

The existing round-trip assertions added by plan 398 cover `PersistedMutation`'s full
shape (`id`, `clientId`, `functionPath`, `args`, `identity`, `shardKey`, `version`).

**Verify**:

- `pnpm --filter "@lunora/client" run test` → exit 0, no pre-existing test modified
  other than additively
- `pnpm run api:check` → exit 0 (no public type changed)

## Test plan

- **Exemplar file**: `packages/client/__tests__/persistence.test.ts` — the outbox
  adapter suite, extended by PR #440 to assert the full `PersistedMutation` shape.
  `packages/client/__tests__/async-storage-query-cache.test.ts` is the model for the
  wire-codec assertions (it already covers `bigint`/`Date`/bytes round-trips through
  the same `singleBlobStore`); copy its storage-double setup rather than writing a new one.
- 5 new tests: bigint round-trip, Date round-trip, legacy plain-JSON blob, corrupt
  blob, non-encodable rejection (+ blob not corrupted by it).

## Platform parity

Not applicable — this is browser/React-Native client-side storage. It touches no
`ctx.*` surface, no provider binding, and no deploy/runtime capability. The wire format
on the network is unchanged (the transport already encoded these args); only the
on-device durable representation changes.

## Done criteria

- [ ] `pnpm --filter "@lunora/client" run test` exits 0 with the 5 new tests
- [ ] `pnpm --filter "@lunora/client" run lint:types` exits 0
- [ ] `pnpm --filter "@lunora/client" run lint:eslint` exits 0
- [ ] `pnpm run api:check` exits 0
- [ ] `grep -n "encodeWire\|decodeWire" packages/client/src/async-storage-persistence.ts`
      → both present
- [ ] `grep -n "encodeWire" packages/client/src/single-blob-store.ts` → **no** matches (D1)
- [ ] A plain-JSON blob written by the previous version still loads (Step 3 test 1)
- [ ] `git status --porcelain` shows no file outside the in-scope list, except the one
      permitted docblock line in `async-storage-query-cache.ts`

## STOP conditions

- **STOP** if `packages/client/src/single-blob-store.ts` does not exist — PR #440 has
  not merged and this plan's baseline is wrong.
- **STOP** if the Step 1 bigint test **passes** before the change — something already
  encodes, and the finding needs re-deriving.
- **STOP** if the legacy plain-JSON blob does **not** load after the change. Silently
  discarding an existing on-device outbox loses users' queued writes, which is strictly
  worse than the bug being fixed. If `decodeWire` cannot be made to pass untagged JSON
  through unchanged, fall back to **Option C** and file the reason.
- **STOP** if making `append` reject requires changing `OfflineQueue` or
  `LunoraClient` — the rejection is supposed to flow through the existing
  `onPersistenceError` channel with no new plumbing.
- **STOP** if any existing test has to be _changed_ rather than added to, unless that
  test encoded the bug (say so in the commit body if it did).

## Maintenance notes

- The three persistence adapters must agree on what round-trips. If a fourth is ever
  added, its round-trip suite is the contract — see
  `packages/client/__tests__/persistence.test.ts` and the shared contract suite plan 398
  landed.
- The lesson worth keeping: the wave-22 review fixed the read cache and left the outbox
  on the reasoning that "outbox args are JSON-safe args the caller chose". Nothing in
  the API says that, and the transport does not require it. A comment asserting a
  constraint the code does not enforce is where this class of bug lives.
- Reviewer: check the `async-storage-query-cache.ts` docblock sentence was corrected. A
  stale comment claiming the outbox is the JSON-safe one is how the next reader
  re-introduces the divergence.
