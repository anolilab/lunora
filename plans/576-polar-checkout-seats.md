# Plan 576 — Polar checkout honours `quantity` as seats

**Baseline:** `79b0c5a6a` (2026-11-11)
**Status:** TODO

> **Executor instructions**: Follow this plan step by step. Run every verification command and
> confirm the expected result before moving on. If anything in "STOP conditions" (section 8)
> occurs, stop and report; do not improvise. Do not edit `plans/README.md`.
>
> **Drift check (run first)**:
> `git diff --stat 79b0c5a6a..HEAD -- packages/payment/src/providers/polar.ts packages/payment/__tests__/providers/polar.test.ts`
> Empty output expected; otherwise compare section 1 with the live code and STOP on a mismatch.

Finding row 36 of the 2026-11-11 audit (issue #1527).

## 0. Headline finding

`createCheckout` on the Polar adapter never reads `input.quantity`. A caller who asks for a
5-seat checkout gets Polar's default seat count, while the facade has already folded the quantity
into its idempotency key and the Stripe and Dodo adapters send it. The installed Polar SDK
(`@polar-sh/sdk` 0.49.0) accepts `seats` on `checkouts.create`.

## 1. Current state (audit)

- `packages/payment/src/providers/polar.ts` lines 291-311, `createCheckout`:

    ```ts
    createCheckout: async (input: CheckoutInput): Promise<CheckoutResult> => {
        const client = await loadClient();

        const checkout = await client.checkouts.create({
            customerEmail: input.customerId ? undefined : input.email,
            customerId: input.customerId,
            externalCustomerId: input.referenceId,
            metadata: { ...input.metadata, referenceId: input.referenceId },
            products: [input.priceId],
            returnUrl: input.cancelUrl,
            successUrl: input.successUrl,
        });

        return { id: checkout.id, provider: "polar", url: checkout.url };
    },
    ```

- Same file, `updateSubscription` (lines ~470-505) already maps quantity to Polar's `seats`
  (`polarSubscriptionUpdate`, line 88) and, after the call, throws
  `new LunoraPaymentError("PROVIDER_ERROR", "polar did not apply the seat count … to subscription …")`
  when the returned seat count differs (a non-seat product answers `seats: null`). Copy that pattern
  and argument order.
- Installed SDK, verified: `@polar-sh/sdk@0.49.0`
  `dist/esm/sdk/checkouts.d.ts` line 33: `create(request: CheckoutCreate, …): Promise<Checkout>`;
  `models/components/checkoutcreate.d.ts` lines 68-71: `seats?: number | null | undefined` —
  "Predefined number of seats (works with seat-based pricing only)"; `models/components/checkout.d.ts`
  line 79: the returned `Checkout` also carries `seats?: number | null`.
- `packages/payment/src/types.ts` line 159: `CheckoutInput.quantity?: number`.
- Stripe sends it: `providers/stripe.ts` line 470 `line_items: [{ price: input.priceId, quantity: input.quantity ?? 1 }]`.
- Tests: `packages/payment/__tests__/providers/polar.test.ts`. `makeClient(created, calls)` (lines
  42-60) records `checkouts.create` arguments into `created` and returns
  `{ id: "co_1", url: "https://polar.test/co_1" }`. Checkout tests at lines 138-180 read single
  properties of `created[0]`, not a strict whole-object match.

## 2. Existing seams (do not reinvent)

The `updateSubscription` seat check; `LunoraPaymentError`; `makeClient`.

## 3. The behavioural contract to preserve

A checkout with no `quantity` or `quantity: 1` sends exactly the same request as today (no `seats`
key), so non-seat products keep working. All existing Polar tests pass unchanged.

## 4. Design decisions

- **Chosen:** send `seats: input.quantity` only when `input.quantity` is set and not `1`. After the
  call, when `seats` was sent and `checkout.seats !== input.quantity`, throw `PROVIDER_ERROR` naming
  the checkout id, mirroring the `updateSubscription` check. A why-comment says that Polar applies
  `seats` only to seat-based prices and a silent mismatch would bill the wrong seat count.
- **Rejected:** throwing `PROVIDER_ERROR` for any `quantity > 1` (unsupported). The SDK supports it.
- To let tests drive the returned seats, extend `makeClient` with an optional way to echo seats
  (e.g. return `{ id, seats: parameters.seats ?? null, url }`), without breaking existing callers.

## 5. Workstreams

One workstream, size S. One commit, type `fix`, scope `payment`.

### Commands you will need

| Purpose         | Command (worktree root)                                                                                      | Expected |
| --------------- | ------------------------------------------------------------------------------------------------------------ | -------- |
| Install         | `pnpm install --frozen-lockfile`                                                                             | exit 0   |
| Build deps once | `pnpm --filter "@lunora/payment..." run build`                                                               | exit 0   |
| Test file       | `pnpm --filter "@lunora/payment" exec vitest run __tests__/providers/polar.test.ts`                          | all pass |
| Package tests   | `pnpm --filter "@lunora/payment" run test`                                                                   | all pass |
| Format          | `pnpm exec oxfmt packages/payment/src/providers/polar.ts packages/payment/__tests__/providers/polar.test.ts` | exit 0   |
| ESLint          | `pnpm --filter "@lunora/payment" run lint:eslint`                                                            | exit 0   |
| Types           | `pnpm --filter "@lunora/payment" run lint:types`                                                             | exit 0   |

### Scope

**In scope:** `packages/payment/src/providers/polar.ts`,
`packages/payment/__tests__/providers/polar.test.ts`.

**Out of scope:** `create-payment.ts`, other adapters, `package.json` peer ranges,
`plans/README.md`.

### Git workflow

- Branch `fix/improve-576-polar-checkout-seats`, from `origin/alpha`. Do not push.
- One commit: `fix(payment): send checkout quantity to Polar as seats`; body ≤ 3 lines; last line
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Stage explicit paths. Never `git add -A`, `git commit -a`, any `git stash`, `--no-verify`.

### Executor rules

- Work only inside your worktree; absolute paths or `cd <worktree> &&` in every shell call.
- Never run `pnpm run test:workerd`, `pnpm run build:packages`, `pnpm run build`, repo-root
  `pnpm run test`, or `pnpm -r …`. Never kill a process by pattern.
- oxfmt before ESLint. No `.js` import extensions. Named exports only. Comments say why.
- No `.skip`, `@ts-expect-error`, `as any`, or new `eslint-disable` without rule + `-- reason`.

### Step 1: Install and build

**Verify:** exit 0.

### Step 2: Write the failing tests

In `polar.test.ts`, next to the checkout tests (line ~138):

1. `quantity: 5` → `created[0]?.seats` is `5`, and the call resolves.
2. No `quantity`, and `quantity: 1` → `created[0]` has no `seats` key
   (`expect("seats" in created[0]).toBe(false)`).
3. `quantity: 5` with a client whose `checkouts.create` returns `seats: null` → rejects with a
   `LunoraPaymentError` whose `code` is `"PROVIDER_ERROR"`.

**Verify:** test-file command → cases 1 and 3 FAIL.

### Step 3: Implement

Per section 4.

**Verify:** test-file command passes.

### Step 4: Gates, then commit

**Verify:** format, ESLint, types, package tests exit 0. Commit. `git status --short` empty.

### Step 5: Prove the tests need the fix (after the commit; no stash)

```bash
git show 79b0c5a6a:packages/payment/src/providers/polar.ts > packages/payment/src/providers/polar.ts
pnpm --filter "@lunora/payment" exec vitest run __tests__/providers/polar.test.ts   # cases 1 and 3 FAIL
git checkout HEAD -- packages/payment/src/providers/polar.ts
git status --short   # empty
```

## 6. Platform parity

Not applicable.

## 7. Phasing & ordering

| Phase | Work      | Gate                                                       |
| ----- | --------- | ---------------------------------------------------------- |
| 0     | Steps 1-5 | new cases red on base, green with fix; payment gates green |

## 8. Risks & STOP conditions

- **STOP** if section 1 does not match the live code.
- **STOP** if `lint:types` rejects `seats` on the `checkouts.create` argument (the installed SDK
  differs from 0.49.0); report the SDK version from `node_modules/@polar-sh/sdk/package.json`.
- **Risk (reviewer, PR text):** the peer range is `^0.48.0`; only 0.49.0 was checked for `seats`.

## 9. Open questions

1. None.

## Done criteria

- [ ] `pnpm --filter "@lunora/payment" run test`, `lint:eslint`, `lint:types` exit 0.
- [ ] Cases 1 and 3 fail against `79b0c5a6a`'s `polar.ts`.
- [ ] `git diff --stat 79b0c5a6a..HEAD` lists only the two in-scope files.

## Maintenance notes

If Polar ever exposes `minSeats`/`maxSeats` to the facade, they belong on `CheckoutInput`, not here.
