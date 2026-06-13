# Plan 003: Persist identity stamps with offline-queue entries so hydrated writes can't replay as another user

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat c865cfa6..HEAD -- packages/client/src/offline-queue.ts packages/client/src/cirrus-client.ts packages/client/src/types.ts packages/client/__tests__/`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED (touches the offline write path; back-compat with already-persisted records must hold)
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `c865cfa6`, 2026-06-13

## Why this matters

The client stamps every queued offline mutation with an identity fingerprint
so a write issued as user A never replays as user B (`queuedIdentities` map +
the flush guard). But the stamp lives **only in memory**: the persisted record
written to IndexedDB carries `{args, functionPath, id, shardKey}` and nothing
else. After a page reload, `hydrate()` restores entries unstamped, and the
flush guard explicitly lets unstamped writes "replay under whatever identity
is current". On a shared device this is the exact privilege leak the stamping
was built to prevent: A queues writes offline, closes the tab, B opens the app
with B's session — A's writes replay as B. The in-session guard already
handles live identity changes (`rejectQueuedForIdentityChange`); only the
reload path is open. Fix: persist the fingerprint with the record and restore
it on hydrate.

## Current state

All in `packages/client/`:

- `src/types.ts:97-102` — the persisted record shape:

```ts
export interface PersistedMutation {
    args: Record<string, unknown>;
    functionPath: string;
    id: string;
    shardKey?: string;
}
```

- `src/offline-queue.ts` — `QueuedMutation` interface (lines 3–13: `args`,
  `functionPath`, `id?`, `reject`, `resolve`, `shardKey?` — no identity field).
  `enqueue` persists at line 87:

```ts
this.persistence?.append({ args: item.args, functionPath: item.functionPath, id: item.id, shardKey: item.shardKey }).catch(...)
```

  `hydrate()` (lines 117–142) restores persisted entries with no-op
  `resolve`/`reject` and returns the distinct shard keys.

- `src/cirrus-client.ts`:
  - line 419: `private readonly queuedIdentities = new Map<string, string | null>();`
  - line ~706: after enqueueing, the client stamps:
    `this.queuedIdentities.set(entry.id, issuingIdentity);`
  - `identityFingerprint()` (lines ~2238–2259): length-prefixed FNV-1a over the
    auth token; `null` is the distinct signed-out identity, `undefined` means
    "not stamped / hydrated". **The doc comments are explicit that `null` and
    `undefined` must not be conflated** — preserve that.
  - `flushOfflineQueue` (lines ~2282–2311) — the guard:

```ts
const stamped = item.id === undefined ? undefined : this.queuedIdentities.get(item.id);

if (stamped !== undefined && stamped !== currentIdentity) {
    // ... reject with code OFFLINE_IDENTITY_CHANGED
}
```

  - `rejectQueuedForIdentityChange()` (lines ~2268–2280) — drains and rejects
    everything on a live identity change, including unpersisting durable
    entries. This path already works; don't change it.
  - The hydrate call site: search for `offlineQueue.hydrate()` in
    `cirrus-client.ts` (a private method restores persisted mutations on
    construct and opens sockets for their shard keys).

- Persistence adapters implement `PersistenceAdapter` (`src/types.ts:104+`,
  `append`/`load`/`remove`/`clear`); the IndexedDB implementation stores the
  record object as-is, so an added optional field round-trips without adapter
  changes. Confirm that by reading the adapter (search for
  `createIndexedDbPersistence` under `packages/client/src/`).

- Tests: `packages/client/__tests__/offline-queue.test.ts` (queue unit tests:
  FIFO drain, overflow un-persist, hydrate order, dedupe-on-hydrate,
  persistence-error reporting) and
  `packages/client/__tests__/cirrus-client.test.ts` (~lines 638–786: queue
  while offline → replay on reconnect; hydrate-on-construct → flush-on-open).
  Model new tests on those.

- Conventions: TypeScript ESM, no `.js` extensions on relative imports, named
  exports only, Vitest. Note the codebase deliberately distinguishes
  `null` vs `undefined` here and carries eslint suppressions for
  `unicorn/no-null` — keep that style.

## Commands you will need

| Purpose   | Command                                            | Expected on success |
|-----------|----------------------------------------------------|---------------------|
| Install   | `pnpm install`                                     | exit 0              |
| Tests     | `pnpm --filter "@cirrus/client" run test`          | all pass            |
| Typecheck | `pnpm --filter "@cirrus/client" run lint:types`    | exit 0              |
| Lint      | `pnpm --filter "@cirrus/client" run lint:eslint`   | exit 0              |

## Scope

**In scope** (the only files you should modify/create):
- `packages/client/src/types.ts` — add optional `identity` to `PersistedMutation`
- `packages/client/src/offline-queue.ts` — carry/persist/restore the stamp
- `packages/client/src/cirrus-client.ts` — stamp at enqueue, restore at hydrate (minimal diffs)
- `packages/client/__tests__/offline-queue.test.ts` — new cases
- `packages/client/__tests__/cirrus-client.test.ts` — new cases
- `plans/README.md` (status row update)

**Out of scope** (do NOT touch, even though they look related):
- `identityFingerprint()` itself — FNV-1a as change-detection is a documented
  design decision; replacing the hash is a separate discussion.
- The persistence adapters' storage format/versioning machinery — the new
  field is optional and additive; no schema migration code.
- `rejectQueuedForIdentityChange` — already correct.
- Any server-side package.

## Git workflow

- Branch: `fix/offline-identity-stamps` off `alpha`.
- Conventional commit, e.g. `fix(client): persist identity stamps with offline mutations` (imperative, lowercase, ≤50 chars).
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Extend the record types

- `src/types.ts` — `PersistedMutation` gains:
  `identity?: string | null;` with a doc comment: the issuing identity
  fingerprint (`null` = signed out); absent on records persisted by older
  client versions, which replay under the ambient identity for back-compat.
- `src/offline-queue.ts` — `QueuedMutation` gains the same optional
  `identity?: string | null` field (readonly, matching the interface style).

**Verify**: `pnpm --filter "@cirrus/client" run lint:types` → exit 0.

### Step 2: Persist and restore the stamp in `OfflineQueue`

- `enqueue` (line ~87): include `identity: item.identity` in the object passed
  to `persistence.append(...)`.
- `hydrate()` (lines ~125–138): copy `identity: mutation.identity` onto the
  restored item.

**Verify**: `pnpm --filter "@cirrus/client" run test -- offline-queue` → existing tests still pass.

### Step 3: Stamp at enqueue and honor restored stamps at flush

In `src/cirrus-client.ts`:

- At the enqueue site (~line 700–710, where `queuedIdentities.set(entry.id, issuingIdentity)`
  happens): also set `identity: issuingIdentity` on the entry object passed to
  `offlineQueue.enqueue(...)`, so the queue persists it. Keep the
  `queuedIdentities` map as-is (it remains the live-session source of truth).
- In `flushOfflineQueue` (~line 2297), change the stamp lookup so a restored
  stamp backs the in-memory map without conflating `null`/`undefined`:

```ts
const liveStamp = item.id === undefined ? undefined : this.queuedIdentities.get(item.id);
const stamped = liveStamp === undefined ? item.identity : liveStamp;
```

  (`Map.get` returns `undefined` for unstamped/hydrated ids; `item.identity`
  is `undefined` for legacy records — both preserve the prior ambient-replay
  behavior; a persisted `null` means "queued while signed out" and now
  correctly mismatches a signed-in replay.)
- Update the comment block above the guard (lines ~2290–2296) to reflect the
  new behavior: hydrated writes now carry their stamp; only legacy
  (pre-this-change) records replay ambiently.

**Verify**: `pnpm --filter "@cirrus/client" run test` → all existing tests pass.

### Step 4: Tests

In `offline-queue.test.ts`:
1. `enqueue` with an `identity` persists it (assert on the adapter mock's
   `append` argument).
2. `hydrate` restores `identity` onto the queued item.
3. Legacy record without `identity` hydrates with `identity === undefined`.

In `cirrus-client.test.ts` (model on the hydrate-on-construct test at ~638–786):
4. **The regression case**: persist a record stamped with identity X (simulate
   by pre-loading the persistence mock with a record carrying an `identity`
   value that cannot match), construct a client whose auth token yields a
   different fingerprint (or no token), let the socket open → the hydrated
   mutation is NOT sent; it is unpersisted and (since hydrated rejects are
   no-ops) simply dropped; assert the adapter's `remove` was called and no RPC
   for that functionPath was issued.
5. **Back-compat**: a legacy persisted record without `identity` still
   replays under the current identity (existing behavior preserved).
6. **Signed-out stamp**: a record persisted with `identity: null` does not
   replay once a user has signed in.

To compute a matching fingerprint for positive cases, do what the existing
identity tests in this suite do (search `cirrus-client.test.ts` for
`OFFLINE_IDENTITY_CHANGED` and reuse that setup pattern). If no such test
exists, derive the stamp by enqueueing through a real client with the same
token and capturing the persisted record from the adapter mock — never
re-implement FNV-1a in the test.

**Verify**: `pnpm --filter "@cirrus/client" run test` → all pass including the 6 new cases.

### Step 5: Full package gates

**Verify**:
- `pnpm --filter "@cirrus/client" run lint:types` → exit 0
- `pnpm --filter "@cirrus/client" run lint:eslint` → exit 0

## Test plan

Enumerated in Step 4 (cases 1–6). Patterns:
`offline-queue.test.ts` for queue-level, the hydrate/flush tests in
`cirrus-client.test.ts:638-786` for client-level.

## Done criteria

- [ ] `grep -n "identity" packages/client/src/types.ts` shows the new `PersistedMutation` field
- [ ] `pnpm --filter "@cirrus/client" run test` exits 0 with the 6 new cases present
- [ ] `pnpm --filter "@cirrus/client" run lint:types` exits 0
- [ ] `pnpm --filter "@cirrus/client" run lint:eslint` exits 0
- [ ] `git status` shows no modified files outside the in-scope list
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- The flush guard or enqueue site no longer matches the excerpts (drift).
- The IndexedDB adapter turns out to validate/whitelist record fields such
  that an extra `identity` key is dropped or rejected — report; adapter
  changes need a separate decision.
- Preserving back-compat (legacy records replaying ambiently) turns out to be
  impossible without behavior changes to stamped live entries.
- You find the `null`-vs-`undefined` distinction cannot survive the round-trip
  through the persistence adapter (e.g. JSON serialization dropping the key).

## Maintenance notes

- The fingerprint is FNV-1a change-detection, not cryptographic — documented
  in `identityFingerprint()`. If the threat model ever requires collision
  resistance, that's a follow-up (and needs a stamp-format migration).
- Anyone adding fields to `PersistedMutation` later should keep them optional
  for the same back-compat reason this plan does.
- Reviewer should scrutinize: the `null`/`undefined` handling in the Step 3
  lookup (a `??` there would silently conflate signed-out with unstamped), and
  that case 5 (back-compat) is actually asserted.
