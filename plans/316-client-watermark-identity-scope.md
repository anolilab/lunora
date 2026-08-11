# Plan 316 — Scope the client's mutation watermark to the identity, so a user switch stops wedging every custom mutator

**Baseline:** `70b7451b5` (2026-08-11)
**Status:** TODO

> **Executor instructions**: follow this file top to bottom. Run every verification
> command and confirm the expected result before the next step. If a STOP condition
> in §8 fires, stop and report — do not improvise. Update this plan's row in
> `plans/README.md` when done.
>
> **Drift check (run first):**
> `git diff --stat 70b7451b5..HEAD -- packages/client/src/lunora-client.ts packages/db/src/define-mutators.ts packages/do/src/shard-do.ts`
> If any of those changed, compare the §1 excerpts against the live code first; a
> mismatch is a STOP condition.
>
> **Build before you measure:** `dist/` is gitignored and built on demand. Run
> `pnpm run build:packages` once before any test/typecheck, or you will chase
> phantom "missing export" errors from a stale dependency build.

## 0. Headline finding

The client caches the custom-mutator watermark **per shard bucket**; the server
records it **per `(identity, clientId)` pair**. Nothing resets the client cache when
the signed-in identity changes. So a page that pushes at least one custom mutator
and then switches user in-place — guest → signed-in, or A signs out and B signs in
without a reload — keeps claiming `staleWatermark + 1` against a server watermark
of `0`. The shard classifies that as a gap and returns `409 OUT_OF_ORDER`, which
carries no ack, so the client's cached watermark never moves and the next attempt
claims the same sequence again. **Every `@lunora/db` custom-mutator write on that
shard is rejected until a full page reload**, with the optimistic overlay rolling
back on each attempt.

## 1. Current state (audit)

### The client keys by bucket only

`packages/client/src/lunora-client.ts:795`

```ts
private readonly clientWatermarks = new Map<string, number>();
```

`packages/client/src/lunora-client.ts:1180` (the public reader `@lunora/db` seeds from):

```ts
return this.clientWatermarks.get(shardKey ?? "") ?? 0;
```

`packages/client/src/lunora-client.ts:1234-1235` (the only writer — an ack):

```ts
if (ackWatermark !== undefined && ackWatermark > (this.clientWatermarks.get(bucket) ?? 0)) {
    this.clientWatermarks.set(bucket, ackWatermark);
}
```

### The server keys by identity

`packages/shard-engine/src/ctx-db-client-watermark.ts:54-57`

```sql
identity TEXT NOT NULL,
client_id TEXT NOT NULL,
...
PRIMARY KEY (identity, client_id)
```

`packages/do/src/shard-do.ts:2790-2795` — the classifier reads that pair:

```ts
// Scope the watermark to the authenticated identity (as `__idempotency`
// does), so a reused/spoofed `clientId` under a different user can't
// suppress the real owner's sequence.
const identity = this.currentRequestUserId ?? "";
```

The identity scoping on the server is deliberate and **must not be relaxed** — it is
what stops one user suppressing another's sequence with a borrowed `clientId`.

### The identity-change branch never touches the cache

`packages/client/src/lunora-client.ts:1100-1148` — `setAuthToken` already detects an
identity change and reacts on three surfaces: it drains/rejects the offline queue
(`rejectQueuedForIdentityChange`), re-stamps queued writes on a subject-only change
(`restampQueuedIdentity`), and restarts the cross-tab coordinator on the re-derived
channel. It does not clear `clientWatermarks`.

### The reissue loop cannot self-heal

`packages/db/src/define-mutators.ts:273-278`

```ts
const nextClientSeq = (): number => {
    counter = Math.max(counter, client.confirmedMutationWatermark(context.shardKey)) + 1;

    return counter;
};
```

`packages/db/src/define-mutators.ts:305-311` — on rejection it surrenders the counter
back to _the same stale cached value_, then rethrows:

```ts
counter = client.confirmedMutationWatermark(context.shardKey);

throw error;
```

So the next push re-derives `stale + 1` and is rejected identically. The 32-attempt
backstop does not help — the catch rethrows rather than looping, and every fresh
push repeats the same claim.

### The server's rejection

`packages/do/src/shard-do.ts:2846-2857` returns `409` with `code: "OUT_OF_ORDER"` and
`expectedMutationId`, and **no ack** — which is precisely why the client cache is
never corrected.

## 2. Existing seams (do not reinvent)

- **`identityFingerprint()`** (`lunora-client.ts`, used at `:1095`, `:1104`, `:1167`,
  `:1814`) — the canonical identity stamp. `:1814` already uses it to scope a
  read-cache entry, so scoping a map by it is an established pattern in this file.
- **The identity-change branch at `lunora-client.ts:1106`** — the fix belongs inside
  it. Do not add a second detector.
- **`confirmedMutationWatermark(shardKey)`** (`:1177-1181`) — the public reader. Its
  signature must not change; `@lunora/db` and the follower path both call it.

## 3. The behavioural contract to preserve

1. `confirmedMutationWatermark(shardKey)` keeps its signature and still returns `0`
   for an unseen bucket.
2. A same-credential refresh (token unchanged, subject resolving late) must **not**
   drop the watermark — that path currently re-stamps rather than drains, and losing
   the watermark there would reintroduce the gap this plan fixes, in reverse.
3. The follower/leader watermark exchange at `lunora-client.ts:1583-1589` iterates
   `clientWatermarks.keys()` and publishes `{ shardKey → watermark }`. Whatever key
   shape you choose, that projection must still emit **bucket** keys, not composite
   ones, or cross-tab state silently corrupts.
4. Server behaviour is untouched. No change under `packages/do/` or
   `packages/shard-engine/`.

## 4. Design decisions

**Chosen: key the map by `${identityFingerprint()}�${bucket}`.**
Rejected: `clientWatermarks.clear()` inside the identity-change branch. Clearing works
for the reported bug but throws away the previous identity's watermark, so switching
_back_ to user A restarts A from 0 and re-wedges A on the same shard until the server
acks — the exact bug, one user-switch later. Composite keying makes both directions
recover, and it makes the invariant visible in the data structure instead of in a
branch three hundred lines away.

**Chosen: fix the `@lunora/db` counter too.** The module keeps its own `counter` in a
closure (`define-mutators.ts:269`). Re-scoping only the client map leaves that closure
holding the stale value for the lifetime of the binding. It must re-derive from the
client on identity change; the simplest correct form is to drop the memo and always
take `Math.max(counter, watermark)` from a _correctly scoped_ client — which is what
it already does, so this reduces to resetting `counter` when the client's identity
stamp changes. Store the fingerprint alongside the counter and reset both on mismatch.

## 5. Workstreams

### WS1 — Re-scope `clientWatermarks` (S)

In `packages/client/src/lunora-client.ts`:

1. Add a private helper next to the map:

    ```ts
    /** Watermark cache key: the server records the watermark per `(identity, clientId)`, so the client must too — a bucket-only key lets a user switch claim the previous identity's sequence and wedge on `OUT_OF_ORDER`. */
    private watermarkKey(bucket: string): string {
        return `${this.identityFingerprint() ?? ""}�${bucket}`;
    }
    ```

    (Check the actual return type of `identityFingerprint()` at its declaration and
    match it — if it already returns a non-nullable string, drop the `?? ""`.)

2. Route the reader (`:1180`) and the writer (`:1234-1235`) through it.

3. Fix the cross-tab projection at `:1583-1589`: it currently unions
   `connections.keys()` with `clientWatermarks.keys()` and emits each key as a
   `shardKey`. With composite keys it must strip the identity prefix — split on
   `"�"` and take the tail — and it must only publish entries whose identity
   prefix matches the _current_ fingerprint. Publishing another identity's watermark
   to the tab group is a correctness regression, not a cosmetic one.

**Verify:** `pnpm --filter "@lunora/client" run lint:types` → exit 0.

### WS2 — Reset the `@lunora/db` mutator counter on identity change (S)

In `packages/db/src/define-mutators.ts`, alongside `let counter = 0` (`:269`), track
the identity the counter was derived under and reset when it moves:

```ts
let counterIdentity = client.currentIdentity();
...
const nextClientSeq = (): number => {
    const identity = client.currentIdentity();

    if (identity !== counterIdentity) {
        // The watermark is server-side keyed by identity, so a switch resets the
        // sequence space; carrying the old counter forward claims a gap the shard
        // rejects as OUT_OF_ORDER, permanently.
        counter = 0;
        counterIdentity = identity;
    }

    counter = Math.max(counter, client.confirmedMutationWatermark(context.shardKey)) + 1;

    return counter;
};
```

`currentIdentity()` is already public (`lunora-client.ts:1166-1168`). Apply the same
reset in the catch at `:305-311` — or, better, have the catch call the same private
helper so there is one reset site.

**Verify:** `pnpm --filter "@lunora/db" run lint:types` → exit 0.

### WS3 — Regression tests (S)

See §"Test plan".

## 6. Platform parity

Not applicable — no `ctx.*` surface, no provider binding, no deploy/runtime
capability. Client-side cache keying only; the server contract is unchanged.

## 7. Phasing & ordering

| Phase | Work            | Gate                                                                          |
| ----- | --------------- | ----------------------------------------------------------------------------- |
| 0     | WS1             | `pnpm --filter "@lunora/client" run test` green, incl. the new watermark test |
| 1     | WS2             | `pnpm --filter "@lunora/db" run test` green, incl. the new counter test       |
| 2     | WS3 + full lint | `pnpm run lint:eslint` and `pnpm run lint:prettier` exit 0                    |

## Commands you will need

| Purpose               | Command                                              | Expected               |
| --------------------- | ---------------------------------------------------- | ---------------------- |
| Build deps first      | `pnpm run build:packages`                            | exit 0                 |
| Client tests          | `pnpm --filter "@lunora/client" run test`            | all pass               |
| DB tests              | `pnpm --filter "@lunora/db" run test`                | all pass               |
| Typecheck             | `pnpm --filter "@lunora/client" run lint:types`      | exit 0                 |
| Format then lint      | `pnpm run lint:prettier:fix && pnpm run lint:eslint` | exit 0 (order matters) |
| Public API unchanged? | `pnpm run api:check`                                 | exit 0                 |

## Scope

**In scope:**

- `packages/client/src/lunora-client.ts`
- `packages/db/src/define-mutators.ts`
- `packages/client/__tests__/` — one new or extended spec
- `packages/db/__tests__/` — one new or extended spec

**Out of scope (do NOT touch):**

- `packages/do/src/shard-do.ts` and `packages/shard-engine/src/ctx-db-client-watermark.ts`
  — the server-side identity scoping is correct and load-bearing for a security
  property. Widening it to "bucket only" would make the symptom disappear and open
  the sequence-suppression hole the comment at `shard-do.ts:2790` describes.
- The public signature of `confirmedMutationWatermark`.
- `packages/shard-engine/src/durable-stream.ts` and any uncommitted work in
  `packages/server/src` — another change is in flight there.

## Git workflow

- Branch: `advisor/316-client-watermark-identity-scope`
- Conventional commits, imperative, lowercase, ≤50-char subject. Example from
  history: `fix(codegen): annotate self-referential FKs so they infer`.
  Suggested: `fix(client): scope mutation watermark cache by identity`
- Do not push or open a PR unless told to.

## Test plan

**`packages/client/__tests__/` — new `client-watermark-identity.test.ts`** (model the
harness on any existing spec in that directory that constructs a `LunoraClient`
directly):

1. Ack a watermark of `5` on bucket `""` under identity A → `confirmedMutationWatermark(undefined)` is `5`.
2. `setAuthToken(tokenB, "user-b")` → `confirmedMutationWatermark(undefined)` is `0`.
   **This is the regression test; it fails on today's code.**
3. `setAuthToken(tokenA, "user-a")` again → back to `5` (the composite-key win the
   `clear()` alternative would lose).
4. A subject-only resolve on an unchanged token does **not** reset the watermark
   (contract §3.2).
5. The cross-tab publish path emits bare bucket keys, never a key containing
   `"�"`.

**`packages/db/__tests__/` — extend the existing mutator spec** (find it with
`ls packages/db/__tests__ | grep -i mutator`):

6. Push a mutator, ack seq 3, switch identity, push again → the claimed `clientSeq`
   is `1`, not `4`.

**Verify:** both suites green, 6 new assertions.

## Done criteria

- [ ] `pnpm run build:packages` exits 0
- [ ] `pnpm --filter "@lunora/client" run test` and `pnpm --filter "@lunora/db" run test` exit 0
- [ ] The new "identity switch resets the watermark" test fails when WS1 is reverted (prove it: stash the fix, run it, restore)
- [ ] `pnpm --filter "@lunora/client" run lint:types` and `pnpm --filter "@lunora/db" run lint:types` exit 0
- [ ] `pnpm run api:check` exits 0 (no public-surface change expected)
- [ ] `grep -n "clientWatermarks.get(" packages/client/src/lunora-client.ts` shows every read going through the key helper
- [ ] `git status` shows no files outside the in-scope list
- [ ] `plans/README.md` row updated

## 8. Risks & STOP conditions

- **STOP** if `identityFingerprint()` turns out not to be stable across a token
  refresh for the same user (check its implementation): a fingerprint that changes on
  every JWT refresh would make the composite key drop the watermark on every refresh —
  the same wedge, more often. If so, report and re-scope: the key must be the
  _subject_ when one is available.
- **STOP** if the cross-tab coordinator persists `clientWatermarks` keys anywhere
  durable (IndexedDB, localStorage). A stored bucket-keyed entry read back under the
  new scheme would be a silent miss; that needs a migration decision, not a guess.
- **Risk:** the follower path at `lunora-client.ts:3652` gates a watermark on
  `clientId === this.clientId`. Re-read it after WS1 and confirm it still lines up
  with the new key shape.
- **Risk (low):** a watermark reset that is too _aggressive_ claims a sequence the
  server already holds. That direction is safe — the server acks it as `already`
  rather than double-applying (`shard-do.ts:2835-2841`) — which is why resetting to
  `0` is the correct failure direction.

## 9. Open questions

1. Should `clientWatermarks` be bounded? Composite keys grow one entry per
   (identity, bucket) pair; a long-lived tab cycling many identities leaks slowly.
   Probably not worth an LRU — record the answer here either way.
2. Does the durable `OutboxSink` replay path need the same identity scoping? It has
   its own `currentIdentity()` guard (documented at `lunora-client.ts:1160-1165`) —
   confirm during execution and note the result.
