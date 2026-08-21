# Plan 396: Scope the shared CheckpointRegistry by identity so a user switch cannot release overlays against the previous user's watermark

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. Your reviewer maintains `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 207be1b63..HEAD -- packages/db/src/collection-options.ts packages/db/src/define-mutators.ts`
> If either file changed since this plan was written, compare the "Current
> state" excerpts against the live code before proceeding; on a mismatch,
> treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `207be1b63`, 2026-08-21

## Why this matters

`getShardCheckpoints` keys the per-shard `CheckpointRegistry` by `(client, shardKey)` only. The registry's gate (`createGate`) holds a `highest` watermark that only ever advances and is never reset. Meanwhile `bindMutators` deliberately resets its `clientSeq` counter to `0` on an identity change (plan 316, wave 21: the server's watermark is keyed per identity). So after a sign-out/sign-in, the new user's first mutation is acknowledged as `appliedSeq = 1`, but `checkpoints.awaitMutationId(1)` is answered by the **previous** user's gate — whose `highest` may be 47 — and resolves synchronously. The TanStack optimistic overlay is dropped before the new identity's authoritative row has synced, producing exactly the "row flashes out and back" the registry's own docblock guarantees against.

## Current state

- `packages/db/src/collection-options.ts` — the registry, gate, and `getShardCheckpoints`:
  - `:24-31` (gate never regresses):
    ```ts
    const createGate = (): Gate => {
        let highest = Number.NEGATIVE_INFINITY;
        ...
        advance: (value) => {
            if (value <= highest) { return; }
            highest = value;
    ```
  - `:90` — `const registriesByClient = new WeakMap<LunoraClient, Map<string, CheckpointRegistry>>();`
  - `:331-344` — `getShardCheckpoints(client, shardKey, options)` keys the inner map by `const key = shardKey ?? "";` — no identity anywhere.
  - `:85-88` — the invariant to preserve: "A registry MUST be shared by every collection on the same shard" (a per-collection registry hangs `isPersisted` forever).
  - `:380-392` — `releaseShardCheckpoints(client)` resolves all waiters with `Number.POSITIVE_INFINITY` and disposes each registry; exported, but nothing calls it on identity change.
  - `:197` / `:289` — `CheckpointRegistry.dispose()` exists and guarantees no armed fallback timer survives.
- `packages/db/src/define-mutators.ts`:
  - `:270-284` — `resetCounterForIdentity()` lazily re-checks `client.currentIdentity()` and resets the seq counter; this is the pattern to mirror (no event hook exists — identity change is detected lazily).
  - `:366-378` — `resolveCheckpoints()` is called **per mutation** (`:430`), so it re-resolves through `getShardCheckpoints` on every ack — a lazy identity sweep inside `getShardCheckpoints` is picked up automatically by the mutator path.
  - `:430-441` — the ack path: `checkpoints.acknowledge({ mutationId: appliedSeq }); await checkpoints.awaitMutationId(appliedSeq);`
- `packages/client/src/lunora-client.ts:1212` — `public currentIdentity(): string | null` is the identity source.

## Commands you will need

| Purpose   | Command | Expected on success |
|-----------|---------|---------------------|
| Install   | `pnpm install` | exit 0 |
| Build deps | `pnpm --filter "@lunora/db..." run build` | exit 0 |
| Tests     | `pnpm --filter "@lunora/db" run test` | all pass |
| Typecheck | `pnpm --filter "@lunora/db" run lint:types` | exit 0 |
| Lint      | `pnpm --filter "@lunora/db" run lint:eslint` | exit 0 |

## Scope

**In scope** (the only files you should modify):
- `packages/db/src/collection-options.ts`
- `packages/db/__tests__/collection-options.test.ts`

**Out of scope**:
- `packages/db/src/define-mutators.ts` — its lazy `resolveCheckpoints()` already re-resolves per mutation; no change needed there.
- `packages/client/` — `currentIdentity()` is a read-only input.
- The `clientSeq`/watermark logic from plan 316 — already correct.

## Git workflow

- Branch: `improve/wave22-db`
- Commit: `fix(db): scope shard checkpoint registries by identity`

## Steps

### Step 1: Add a lazy identity sweep to `getShardCheckpoints`

In `collection-options.ts`, alongside `registriesByClient`, add a `WeakMap<LunoraClient, string | null>` recording the identity the client's registries were minted under. At the top of `getShardCheckpoints`:

```ts
const identity = client.currentIdentity();
if (registriesByClient.has(client) && identityByClient.get(client) !== identity) {
    // The registries belong to the previous identity: settle their waiters and
    // disarm their timers (the old writes were already durable server-side),
    // then start fresh so the new identity's watermark space starts empty.
    releaseShardCheckpoints(client);
}
identityByClient.set(client, identity);
```

`releaseShardCheckpoints` already resolves waiters with `POSITIVE_INFINITY`, disposes each registry, and deletes the map — reuse it; do not re-implement its teardown. Keep the inner map keyed by `shardKey ?? ""` (the sharing invariant at `:85-88` is per-identity now, which is the point).

**Verify**: `pnpm --filter "@lunora/db" run lint:types` → exit 0.

### Step 2: Also sweep in `lunoraCollectionOptions`' resolution path

`collection-options.ts:505` resolves `options.checkpoints ?? getShardCheckpoints(...)` at collection setup — that call now performs the sweep too (no extra code). Confirm by reading that the only mint paths are `getShardCheckpoints` and the explicit `createCheckpointRegistry` (explicit registries are caller-owned; the sweep must NOT touch them — verify `releaseShardCheckpoints` only iterates the derived map).

**Verify**: `grep -n "createCheckpointRegistry" packages/db/src/collection-options.ts` → the standalone factory does not register into `registriesByClient` (read the function body to confirm; if it does register, STOP).

### Step 3: Regression test

In `packages/db/__tests__/collection-options.test.ts` (model on the existing `describe(releaseShardCheckpoints, ...)` block at `:175`, which shows how a fake client is built):

1. Mint a registry for identity A, `resolve({ mutationId: 47, checkpoint: 47 })`.
2. Switch the fake client's `currentIdentity()` return to identity B.
3. Call `getShardCheckpoints` again for the same shard; assert it is a **different** registry instance and that `awaitMutationId(1)` on it does **not** resolve until `resolve`/`acknowledge` is called on the new registry (use `Promise.race` with a resolved sentinel to assert pending).
4. Assert the identity-A registry's waiters were settled (its `awaitMutationId(48)` promise resolved) so nothing hangs.

**Verify**: `pnpm --filter "@lunora/db" run test` → all pass including the new tests.

## Test plan

- New tests as in Step 3 (same-identity calls still return the same instance — the sharing invariant; identity switch mints fresh and settles old).
- Existing suite must stay green.

## Done criteria

- [ ] `pnpm --filter "@lunora/db" run test` exits 0 with the new identity-switch tests
- [ ] `pnpm --filter "@lunora/db" run lint:types` and `lint:eslint` exit 0
- [ ] `git status` shows only in-scope files modified

## STOP conditions

- The excerpts above don't match the live code (drift).
- `createCheckpointRegistry` (the explicit factory) turns out to register into `registriesByClient` — the sweep would then dispose caller-owned registries; report instead of adapting.
- A fake `LunoraClient` with a mutable `currentIdentity()` cannot be constructed from the existing test helpers — report what the tests actually use.

## Maintenance notes

- The sweep is lazy (detected at the next `getShardCheckpoints` call), mirroring `resetCounterForIdentity` in `define-mutators.ts`. If `LunoraClient` ever grows an identity-change event, both lazy checks could subscribe to it instead.
- Reviewer: scrutinize that collections created **before** a switch still settle (`releaseShardCheckpoints` resolves with `POSITIVE_INFINITY`, so their `isPersisted` promises resolve rather than hang).
- Deferred: collections holding a pre-switch registry keep advancing it via pokes until the app rebuilds them; that stale traffic is harmless (the registry has no waiters after the sweep) and rebuilding collections on identity change is the app's job.
