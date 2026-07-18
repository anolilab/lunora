# Plan 140: Harden the x402 pay-rail spend policy (asset check, per-run race, unbounded allowlist)

> **Executor instructions**: Follow step by step; run each Verify. This plan
> touches **money-signing** code — do not loosen any check, and honor every STOP
> condition. Update this plan's row in `plans/README.md` when done.
>
> **Drift check (run first)**: `git diff --stat f41f1823..HEAD -- packages/x402/src/pay/policy.ts packages/x402/src/pay/fetch.ts packages/x402/__tests__/pay-policy.test.ts`
> On any change, compare the "Current state" excerpts to live code; mismatch ⇒ STOP.

## Status

- **Priority**: P1
- **Effort**: S–M
- **Risk**: MED (behavior change for existing policies; money path)
- **Depends on**: none
- **Category**: security
- **Planned at**: commit `f41f1823`, 2026-07-18

## Why this matters

`@lunora/x402`'s pay rail signs stablecoin payments on an agent's behalf under a
`SpendPolicy`. Three holes let a policy that *looks* bounded authorize far more
than intended:

1. **Unverified asset (X402-01).** `buildSpendPolicy` compares `requirement.amount`
   (atomic units) against a USD cap converted at a fixed `decimals` (default 6),
   assuming a $1-pegged 6-decimal stablecoin — but it never checks
   `requirement.asset`. The EVM/SVM schemes sign a transfer against whatever token
   contract the *server* names. A malicious 402 server can name any token the agent
   wallet holds; the atomic-unit comparison then mis-prices it (a higher-value-per-unit
   token passes a tiny cap at full face value). `recordSpend` also sums atomic units
   across possibly-different assets into one ledger, corrupting `maxPerRun`.
2. **Per-run check-then-act race (X402-02).** The per-run cap is *read* in the
   before-hook (`buildPaymentGuard`) and only *added* in the after-hook
   (`recordSpend`), with `await`s in between (the optional `onPaymentRequired` and
   the async signing). N concurrent paid fetches through one `PayFetch` each pass
   the guard against the same `spentAtomic`, then all record — cumulative spend
   exceeds `maxPerRun` by up to (N−1)×maxPerCall. In an agent loop firing parallel
   paid fetches this is the normal case.
3. **Allowlist-only "bounded" (X402-03).** `assertBoundedPolicy` treats a policy
   with only `allowedNetworks` or only `allowedRecipients` as bounded — but neither
   caps spend. `policy: { allowedNetworks: ["base"] }` builds a wallet with
   *unlimited* spend to *any* recipient on Base — the exact outcome the guard's own
   docstring calls "never the intent".

## Current state

`packages/x402/src/pay/policy.ts`:

- `SpendPolicy` interface (from line 50): `allowedNetworks?`, `allowedRecipients?`,
  `decimals?`, `maxPerCall?`, `maxPerRun?`. **No `allowedAssets` field today.**
- `DEFAULT_STABLECOIN_DECIMALS = 6` (line 40). The doc (lines 34–37) notes
  `@x402/evm` / `@x402/svm` export a `DEFAULT_STABLECOINS` map.
- `buildSpendPolicy` (129–153) — filters on `amount`/`network`/`payTo`; **`asset`
  is never referenced**.
- `SpendState` (74–83) + `createSpendState` (85–…) expose a `spentAtomic` getter
  and an `add(delta: bigint)` method. There is **no `release`/`subtract`** today.
- `buildPaymentGuard` (161–186) — before-hook: reads
  `state.spentAtomic + amount > maxPerRun`, then `await policy.onPaymentRequired`.
- `recordSpend` (193–199) — after-hook: `state.add(BigInt(context.selectedRequirements.amount))`.
- `assertBoundedPolicy` (207–221) — `bounded` is true if ANY of maxPerCall,
  maxPerRun, allowedRecipients.length, allowedNetworks.length, onPaymentRequired
  is set.

`packages/x402/src/pay/fetch.ts` (44–54) wires them on one shared state:
```ts
assertBoundedPolicy(config.policy);
const state = createSpendState();
client.registerPolicy(buildSpendPolicy(config.policy));
client.onBeforePaymentCreation(buildPaymentGuard(config.policy, state));
client.onAfterPaymentCreation(recordSpend(state));
```

Tests: `packages/x402/__tests__/pay-policy.test.ts` (model new cases on it).

Conventions: ESM, no `.js` extensions; named exports only.

## Commands you will need

| Purpose   | Command                                            | Expected |
|-----------|----------------------------------------------------|----------|
| Build deps| `pnpm run build:packages`                          | exit 0   |
| Typecheck | `pnpm --filter "@lunora/x402" run lint:types`      | exit 0   |
| Tests     | `pnpm --filter "@lunora/x402" run test`            | all pass (workerd project is gated behind `LUNORA_WORKERD_TESTS=1`; the default node run is what must pass) |

## Scope

**In scope**:
- `packages/x402/src/pay/policy.ts`
- `packages/x402/src/pay/fetch.ts` (only if the failure-hook wiring for X402-02 requires it)
- `packages/x402/__tests__/pay-policy.test.ts`

**Out of scope**:
- The signer/wallet code (`wallet.ts`) — private-key handling was audited clean.
- `@x402/*` vendored dist — do not modify node_modules.
- The charge rail (`charge/middleware.ts`) — that's plan 146.

## Git workflow

- Branch: `advisor/140-x402-spend-policy`
- Commit e.g. `fix(x402): enforce asset allowlist, atomic per-run reserve, real spend bound`.

## Steps

### Step 1 (X402-03): require a real monetary bound

In `assertBoundedPolicy`, drop `allowedRecipients`/`allowedNetworks` from the
`bounded` test — treat allowlists as *narrowing*, not *bounding*. A policy is
bounded iff at least one of `maxPerCall`, `maxPerRun`, `onPaymentRequired` is set:

```ts
const bounded =
    policy.maxPerCall !== undefined ||
    policy.maxPerRun !== undefined ||
    policy.onPaymentRequired !== undefined;
```

Update the throw message to list only those three as sufficient bounds (remove the
misleading `allowedRecipients`/`allowedNetworks` mentions).

**Verify**: `pnpm --filter "@lunora/x402" run lint:types` → exit 0.

### Step 2 (X402-01): reject requirements whose asset isn't an allowed stablecoin

> **REVISED after a 2026-07-18 execution attempt** — the original premise below was
> FALSIFIED during execution and must not be used:
> - `@x402/evm`'s real `DEFAULT_STABLECOINS` is **not** uniformly 6-decimal — it
>   contains at least one non-6-decimal entry (`eip155:4326` "MegaUSD", `decimals: 18`),
>   so gating on that map does NOT guarantee the fixed-6-decimal amount comparison is
>   correct.
> - `@x402/svm` has **no** `DEFAULT_STABLECOINS`-shaped export at all (only raw
>   `USDC_*_ADDRESS` constants / `getUsdcAddress()`).
>
> **Corrected approach:** do not assume any asset's decimals. Add
> `allowedAssets?: ReadonlyArray<{ asset: string; network: X402Network; decimals: number }>`
> to `SpendPolicy` (explicit per-asset decimals). In `buildSpendPolicy`, for each
> requirement: (a) find the matching allowed asset by normalized `asset` + `network`;
> reject (`return false`, fail closed) if none matches; (b) convert the USD cap to
> atomic units using **that matched asset's `decimals`** (not `policy.decimals`), then
> compare. When `allowedAssets` is unset, fall back to a small built-in table of known
> 6-decimal dollar stablecoins per supported network (USDC addresses via
> `@x402/evm`/`@x402/svm`'s address constants — NOT the mixed-decimal
> `DEFAULT_STABLECOINS` map), each with an explicit `decimals: 6`; reject anything not
> in it. `recordSpend`/the per-run ledger must also key/scale per asset, or restrict a
> single run to one asset — summing atomic units across different-decimal assets is
> meaningless.
>
> STOP and report if you cannot obtain reliable per-asset decimals for the assets in
> play — do not ship the amount check against an assumed decimal count.

**Verify**: `pnpm --filter "@lunora/x402" run test` → existing tests pass; add the
asset-rejection test in Step 4.

### Step 3 (X402-02): reserve the per-run cap atomically

Make the per-run accounting reserve-before-sign, release-on-failure, so no `await`
sits between the check and the debit:

1. Add a `release(delta: bigint)` (or `subtract`) method to `SpendState`
   (mirror `add`), clamping at 0.
2. In `buildPaymentGuard`, after the `maxPerRun` check passes, **reserve**
   immediately: `state.add(amount)` *before* the `await policy.onPaymentRequired`.
   If `onPaymentRequired` declines (or throws), `state.release(amount)` before
   returning the abort.
3. Delete the `recordSpend` after-hook wiring (the reserve now IS the record). If
   the client exposes an `onPaymentCreationFailure` (or equivalent) hook, register a
   handler that calls `state.release(amount)` so an aborted/failed signature frees
   the reservation. Check `client`'s hook surface in `fetch.ts` /
   `node_modules/.pnpm/@x402+core@*/…`; if no failure hook exists, keep the reserve
   but document (a code comment at the reserve site) that a signature failure
   over-counts until the run ends — that direction is fail-closed (over-blocks,
   never over-spends) and acceptable.

**Verify**: `pnpm --filter "@lunora/x402" run lint:types` → exit 0.

### Step 4: tests

In `pay-policy.test.ts` add:
- **X402-03**: `assertBoundedPolicy({ allowedNetworks: ["base"] })` throws;
  `assertBoundedPolicy({ maxPerCall: … })` does not.
- **X402-01**: a requirement naming an asset not in `allowedAssets` (or not a known
  stablecoin) is filtered out by `buildSpendPolicy`; an allowed-asset requirement
  under the cap passes.
- **X402-02**: two `buildPaymentGuard` calls against one shared `createSpendState()`,
  where the first reserves before the second checks, correctly aborts the second
  when their sum exceeds `maxPerRun` (i.e. no double-pass). If a failure-release hook
  was added, a released reservation frees capacity for a subsequent call.

**Verify**: `pnpm --filter "@lunora/x402" run test` → all pass.

## Done criteria

- [ ] `pnpm --filter "@lunora/x402" run lint:types` exits 0
- [ ] `pnpm --filter "@lunora/x402" run test` exits 0 with the new cases
- [ ] `assertBoundedPolicy` no longer counts `allowedNetworks`/`allowedRecipients` as a bound
- [ ] `buildSpendPolicy` rejects a requirement whose `asset` is not allowed / not a known stablecoin
- [ ] The per-run cap is reserved before any `await` in `buildPaymentGuard` (grep shows `add`/reserve before `onPaymentRequired`)
- [ ] No out-of-scope files modified (`git status`)
- [ ] `plans/README.md` row updated

## STOP conditions

- `DEFAULT_STABLECOINS` cannot be imported/shaped from `@x402/evm`/`@x402/svm`
  (Step 2) — report; do NOT ship the amount check without an asset gate.
- Removing `recordSpend` breaks an existing test that asserts the old
  record-after semantics — reconcile deliberately (the reserve replaces it),
  don't just delete the assertion; if unsure, report.
- The `@x402/core` client has no way to register the before/failure hooks the plan
  assumes (the `fetch.ts` wiring changed) — report.
- Any change would make a *legitimate* single stablecoin payment under the cap fail
  — that's a regression in the wrong direction; report.

## Maintenance notes

- `allowedAssets` is a new public policy field — document it in the `SpendPolicy`
  JSDoc and any pay-rail docs (`@lunora/x402` README / docs site) alongside
  `maxPerCall`/`maxPerRun`.
- A reviewer must confirm the reserve/release accounting can't under-count (double
  release) or leak (reserve without release on the success path — success keeps the
  reservation, which is correct).
- Future multi-asset support (spending several distinct stablecoins under one run
  cap) needs a per-asset ledger, not the single `spentAtomic` — note for later.
