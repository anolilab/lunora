# Plan 370: Batch the per-feature usage scans in `listBalances`

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. Your reviewer maintains `plans/README.md` — do
> not update it yourself.
>
> **Drift check (run first)**: `git diff --stat 207be1b63..HEAD -- packages/payment/src/create-payment.ts packages/payment/src/store.ts packages/payment/src/database-store.ts`
> If any changed since this plan was written, compare the "Current state"
> excerpts against the live code before proceeding; on a mismatch, treat it
> as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: LOW
- **Depends on**: none
- **Category**: perf
- **Planned at**: commit `207be1b63`, 2026-08-21

## Why this matters

`listBalances` maps every configured feature through `evaluateFeature`, and each metered feature calls `store.sumUsage` — which in the database store reads the **full lifetime usage ledger** for that `(referenceId, featureId)` pair and filters by period in memory (its own `NOTE` concedes `O(events)` per call). A billing page with N metered features issues N unbounded reads per render. One batched read over the reference's events, bucketed by feature in memory, does the same work in a single query.

## Current state

- The fan-out — `packages/payment/src/create-payment.ts:354-361` (inside `listBalances`):
  ```ts
  // `Promise.all` preserves the sorted `featureNames` order.
  return Promise.all(
      featureNames(options.entitlements).map(async (featureId) => {
          return {
              featureId,
              ...(await evaluateFeature(entitlements, subscriptions, referenceId, featureId, 1)),
          };
      }),
  );
  ```
- The per-feature read — `create-payment.ts:210-217` (inside `evaluateFeature`):
  ```ts
  const limit = entitlements.limit(featureId);

  if (limit !== undefined) {
      const used = await store.sumUsage(referenceId, featureId, usagePeriodStart(subscriptions));
      const balance = limit - used;

      return { allowed: balance >= need, balance, limit, unlimited: false, used };
  }
  ```
- The scan — `packages/payment/src/database-store.ts:242-246`:
  ```ts
  sumUsage: async (referenceId, featureId, since) => {
      // NOTE: this reads the full lifetime ledger for the pair and filters in memory — O(events)
      // per call. Fine for typical volumes; for hot metered features, add a per-period rollup row
      // (or a createdAt-range query) so old periods aren't re-scanned on every check/track.
      const rows = await database.findMany("usageEvents", { featureId, referenceId });
  ```
- Both stores share `foldUsage` (`store.ts:85-94` region) so fold semantics are already centralized.
- `PaymentStore.sumUsage` signature: `store.ts:64` — `(referenceId: string, featureId: string, since: number) => Promise<number>`.
- The memory store's `sumUsage`: `store.ts:168-178` — iterates `this.usageEvents.values()` filtering by reference/feature/since.

## The fix

Add one method to `PaymentStore`:

```ts
/** Period usage totals for many features in one read — the batch form of {@link PaymentStore.sumUsage}. */
sumUsageByFeature: (referenceId: string, featureIds: ReadonlyArray<string>, since: number) => Promise<ReadonlyMap<string, number>>;
```

- Database store: ONE `findMany("usageEvents", { referenceId })`, filter to `featureIds` + `createdAt >= since` in memory, bucket by feature, `foldUsage` each bucket. Keep (or update) the existing `NOTE` about rollups.
- Memory store: same bucketing over `this.usageEvents.values()`.
- `listBalances`: compute `usagePeriodStart(subscriptions)` ONCE, call `sumUsageByFeature` once with the metered feature ids (`entitlements.limit(f) !== undefined`), then evaluate each feature from the map. `evaluateFeature` keeps its current shape for the single-feature `check` path — extract the balance-arithmetic core into a tiny pure helper both paths share rather than duplicating it.
- Keep `sumUsage` on the interface — `check`/`track` remain single-feature callers.

## Commands you will need

| Purpose   | Command | Expected on success |
|-----------|---------|---------------------|
| Install   | `pnpm install` | exit 0 |
| Build deps | `pnpm --filter "@lunora/payment..." run build` | exit 0 |
| Tests     | `pnpm --filter "@lunora/payment" run test` | all pass |
| Typecheck | `pnpm --filter "@lunora/payment" run lint:types` | exit 0 |
| Lint      | `pnpm --filter "@lunora/payment" run lint:eslint` | exit 0 |
| API snapshot | `pnpm run build:packages && pnpm run api:update` | exit 0; `api-snapshots/payment.api.md` updated |

## Scope

**In scope**:
- `packages/payment/src/store.ts` (interface + memory implementation)
- `packages/payment/src/database-store.ts`
- `packages/payment/src/create-payment.ts` (`listBalances` only)
- `packages/payment/__tests__/create-payment.test.ts`, `packages/payment/__tests__/database-store.test.ts`
- `api-snapshots/payment.api.md` (via `pnpm run api:update`)

**Out of scope**:
- Per-period rollup rows / `createdAt`-range indexes — the documented future upgrade; this plan only removes the ×N fan-out.
- `check` and `track` — they stay on single-feature `sumUsage`.
- Any custom third-party `PaymentStore` implementations (pre-1.0 alpha: adding a required interface member is a break; say so in the commit body).

## Git workflow

- Branch: shared wave branch `improve/wave22-payment`.
- Commit: `perf(payment): batch usage reads in listBalances`

## Steps

### Step 1: Add `sumUsageByFeature` to the interface and both stores

As specified in "The fix". Match the file's member ordering (alphabetical) and doc-comment style.

**Verify**: `pnpm --filter "@lunora/payment" run lint:types` → exit 0.

### Step 2: Rewire `listBalances`

Hoist `usagePeriodStart(subscriptions)` out of the loop; one `sumUsageByFeature` call for the metered subset; per-feature evaluation from the map. Non-metered features keep the boolean `entitlements.has` path. Result array must preserve the sorted `featureNames` order (assert in tests).

**Verify**: `pnpm --filter "@lunora/payment" run test` → existing `listBalances` tests pass unchanged.

### Step 3: Tests

- `database-store.test.ts`: `sumUsageByFeature` over a ledger with 3 features × mixed periods returns the same numbers as 3 `sumUsage` calls (parity assertion), including a feature with zero events (must be `0`, present in the map) and correct `"set"`-marker fold behavior (reuse an existing `foldUsage` fixture sequence).
- `create-payment.test.ts`: `listBalances` result identical before/after (order + values), and — if the store double in that file counts calls — assert exactly one usage read for N metered features.

**Verify**: `pnpm --filter "@lunora/payment" run test` → all pass.

### Step 4: API snapshot

`pnpm run build:packages && pnpm run api:update` (fresh build mandatory), then `pnpm run api:check` → exit 0.

## Test plan

As Step 3 — the sumUsage/sumUsageByFeature parity assertion is the core regression guard.

## Done criteria

- [ ] `grep -n "sumUsageByFeature" packages/payment/src/store.ts packages/payment/src/database-store.ts packages/payment/src/create-payment.ts` → all three hit
- [ ] `pnpm --filter "@lunora/payment" run test` exits 0 with the new tests
- [ ] `pnpm --filter "@lunora/payment" run lint:types` exits 0
- [ ] `pnpm run api:check` exits 0
- [ ] No files outside the in-scope list modified (`git status`)

## STOP conditions

- The excerpts don't match the live code.
- `database.findMany("usageEvents", { referenceId })` isn't supported by the query layer (e.g. requires the compound index) — report; do not invent an index.
- `foldUsage`'s semantics turn out to be order-sensitive in a way that per-feature bucketing changes — stop and report with the failing case.

## Maintenance notes

- The lifetime-scan NOTE still applies to the single batched read; the rollup-row upgrade path documented there is unchanged and remains the next lever.
- Reviewer: confirm `usagePeriodStart` hoisting didn't change which period boundary each feature sees (it was already computed from the same `subscriptions` array per call).
