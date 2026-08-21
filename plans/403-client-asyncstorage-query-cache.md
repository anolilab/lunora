# Plan 403: Ship an AsyncStorage-backed QueryCacheAdapter so React Native gets durable reads, not just durable writes

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. Your reviewer maintains `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 207be1b63..HEAD -- packages/client/src/query-cache.ts packages/client/src/async-storage-persistence.ts packages/react-native/src/create-lunora-client.ts`
> On any change, compare the "Current state" excerpts against the live code;
> on a mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: LOW (additive; opt-in path auto-wired only where nothing was wired before)
- **Depends on**: none
- **Category**: direction (build)
- **Planned at**: commit `207be1b63`, 2026-08-21

## Why this matters

A browser app renders from the durable query cache instantly after restart (IndexedDB is auto-probed). A React Native app on the same code restarts to an empty cache and waits for a socket round-trip: `resolveQueryCacheAdapter` has exactly two durable paths — an explicit adapter or IndexedDB, which RN lacks — and `@lunora/react-native`'s `createLunoraClient` auto-wires AsyncStorage for the write outbox but passes nothing for `queryCache`. Everything needed already exists in-repo: the 4-method `QueryCacheAdapter` interface, the AsyncStorage serialized read-modify-write pattern, and an LRU-by-`ts` eviction reference implementation. This closes the last cheap gap in "local-first out of the box" for the mobile target.

## Current state

- `packages/client/src/query-cache.ts`:
  - `:27-70` — `createInMemoryQueryCache`: `Map`-backed, `clone` via `structuredClone`, `evict()` drops oldest-by-`ts` until under `maxEntries` (`DEFAULT_MAX_ENTRIES`) — this is the eviction semantics to replicate.
  - `:115` — `createIndexedDbQueryCache` — the durable sibling (its `ts`-index eviction is at `:137-165`).
  - `:193-207` — `resolveQueryCacheAdapter(option)`: explicit adapter → as-is; `false` → off; default → IndexedDB probe, else `undefined`.
- `packages/client/src/async-storage-persistence.ts:9-13` — `AsyncStorageLike` (`getItem`/`setItem`/`removeItem`, promise-based); `:35-93` — the serialized-chain read-modify-write pattern over a single key (`serialize` funnels every op through one promise chain; corrupt JSON → start clean). This is the template.
- `packages/react-native/src/create-lunora-client.ts:95-100` — auto-wires `persistence: rest.persistence ?? (storage ? createAsyncStoragePersistence({ storage }) : undefined)`; no `queryCache` wiring.
- `packages/client/src/types.ts:426` — `queryCache?: QueryCacheAdapter | false;` is the client option.
- `StoredQuery` shape: see `query-cache.ts` (entries carry `key`, `ts`, `value`, optional `serverEpoch`/`version`).

## Commands you will need

| Purpose   | Command | Expected on success |
|-----------|---------|---------------------|
| Install   | `pnpm install` | exit 0 |
| Build     | `pnpm --filter "@lunora/client..." run build && pnpm --filter "@lunora/react-native..." run build` | exit 0 |
| Tests     | `pnpm --filter "@lunora/client" run test && pnpm --filter "@lunora/react-native" run test` | all pass |
| Typecheck | both packages `run lint:types` | exit 0 |
| API snapshot | `pnpm run build:packages && pnpm run api:update` | client (+ react-native) snapshots updated |

## Scope

**In scope**:
- `packages/client/src/async-storage-query-cache.ts` (new file)
- `packages/client/src/index.ts` (export the factory + options type)
- `packages/react-native/src/create-lunora-client.ts` (auto-wire)
- `packages/client/__tests__/` (new test file) and the RN factory's existing test
- `api-snapshots/client.api.md`, `api-snapshots/react-native.api.md` (via `api:update`)

**Out of scope**:
- `query-cache.ts`'s existing adapters and `resolveQueryCacheAdapter` (no RN detection there — the wiring lives in the RN factory).
- Persistence (write outbox) code.

## Git workflow

- Branch: `improve/wave22-client`
- Commit: `feat(client): asyncstorage-backed durable query cache`

## Steps

### Step 1: `createAsyncStorageQueryCache`

New file `packages/client/src/async-storage-query-cache.ts`:

```ts
interface AsyncStorageQueryCacheOptions {
    storage: AsyncStorageLike;   // import the type from ./async-storage-persistence
    key?: string;                // default "lunora:query-cache"
    maxEntries?: number;         // default: same DEFAULT_MAX_ENTRIES as the siblings
}
const createAsyncStorageQueryCache = (options: AsyncStorageQueryCacheOptions): QueryCacheAdapter => { ... };
```

Implementation mirrors `createAsyncStoragePersistence` exactly: one JSON blob under one key, every op through the same `serialize` chain shape (copy the `serialize`/`readAll`/`writeAll` pattern — corrupt payload → `[]`). Store entries as a record keyed by query key. `put` sets and then evicts oldest-by-`ts` until `size <= maxEntries` (same loop shape as `createInMemoryQueryCache.evict`); `load` returns all entries; `remove`/`clear` as expected. Values pass through `JSON.stringify` — that is the durability format, same trade-off the persistence adapter already made; do NOT structuredClone.

**Verify**: `pnpm --filter "@lunora/client" run lint:types` → exit 0.

### Step 2: Export

Add `createAsyncStorageQueryCache` + its options type to `packages/client/src/index.ts` next to the persistence export (named exports only — repo convention).

**Verify**: `grep -n "createAsyncStorageQueryCache" packages/client/src/index.ts` → one export line.

### Step 3: Auto-wire in the RN factory

In `create-lunora-client.ts`, mirror the persistence line:

```ts
queryCache: rest.queryCache ?? (storage ? createAsyncStorageQueryCache({ storage }) : undefined),
```

(`rest.queryCache` may be `false` — `??` preserves an explicit opt-out only if `false` short-circuits; `false ?? x` returns `false`, so this is correct.) Extend the factory docblock's "two things" framing to three.

**Verify**: `pnpm --filter "@lunora/react-native" run lint:types` → exit 0.

### Step 4: Tests

- New `packages/client/__tests__/async-storage-query-cache.test.ts` modeled on `persistence.test.ts`'s `createFakeAsyncStorage` helper: put/load round-trip preserves entry shape; eviction drops oldest `ts` beyond `maxEntries`; corrupt stored JSON → `load()` returns `[]`; concurrent `put`s don't clobber (fire N puts without awaiting, then load — all N present or evicted by policy, never a lost subset).
- RN factory test: passing `storage` wires a queryCache (assert via the client option seam the existing factory tests use); explicit `queryCache: false` stays `false`.

**Verify**: both test commands → all pass.

### Step 5: API snapshots

`pnpm run build:packages && pnpm run api:update`; commit the snapshot diffs.

**Verify**: `pnpm run api:check` → exit 0.

## Test plan

As Step 4 (4 adapter cases + 2 factory cases).

## Done criteria

- [ ] `createAsyncStorageQueryCache` exported from `@lunora/client`; RN factory auto-wires it
- [ ] All tests green in both packages; `pnpm run api:check` exits 0
- [ ] `git status` shows only in-scope files modified

## STOP conditions

- `StoredQuery` values turn out not to be JSON-safe (e.g. carry bigints) — report; a serialization format decision is the reviewer's.
- The RN factory has no existing test seam to observe wired options — report what exists instead of inventing an export.

## Maintenance notes

- Single-blob JSON storage rewrites the whole cache per put (bounded by `maxEntries`); if profiling ever shows this hot, per-key storage entries are the upgrade path — note is in the file docblock.
- If `@lunora/client` later adds fields to `StoredQuery`, JSON round-trip keeps them automatically; only non-JSON-safe types need attention.
