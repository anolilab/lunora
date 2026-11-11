# Plan 563 — Remove `ctx.payments.adapter` so nothing bypasses the facade's ownership check

> **Executor instructions.** Follow this plan step by step. Run every `Verify:` command and
> confirm the expected result before moving on. Touch only the files listed under "In scope".
> If any STOP condition occurs, stop and report; do not improvise. Do not update
> `plans/README.md`. **Revisions are new commits: never amend, rebase or force-push.**
>
> **Do not execute while Status is BLOCKED.** Step 4 depends on an owner decision (§9.1).

**Baseline:** `a57c2b565` on `security/improve-559-payment-subscription-facade` (2026-11-11). This
plan adds commits on top of that branch (PR #1544); it is the addendum to plan 559.
**Status:** BLOCKED (owner decision needed: two real call sites read provider capability metadata
through `ctx.payments.adapter`, and the facade has no member for it; see §1.1 and §9.1)
**Priority / Effort / Risk:** P1 / S / LOW. **Category:** security. **Depends on:** plan 559.

## 0. Headline finding

`LunoraPayment` exposes `readonly adapter: PaymentAdapter`, so app code can call any provider
operation (refund, capture, cancel, update, resume) with a bare id and no `authorize` check. The
owner decided on 2026-11-11 to remove the property on alpha. `createPayment` keeps using the
adapter privately. Only the public property and its type member go.

## 1. Current state (audit): every use of `.adapter` on the payments context

Searched `packages/*`, `examples/*`, `templates/*`, `registry/*`, `apps/*`, `tests/*`,
`sdks/*`, every `_generated/` tree and every payment doc, at `a57c2b565`.

### 1.1 Real call sites (code that reads the property)

| Location                                     | Use                                                                                    | Covered by a facade method?                                                                                                                                                                   |
| -------------------------------------------- | -------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `templates/saas/lunora/payment/index.ts:319` | `if (!ctx.payments.adapter.capabilities.checkoutExpiry)` before taking a checkout hold | **No.** The facade refuses inside `createCheckout` (`create-payment.ts:321`), but only after the template has taken its hold. The comment at `:316-318` says the early refusal is deliberate. |
| `templates/saas/lunora/payment/index.ts:322` | `${ctx.payments.adapter.identifier}` in that error message                             | **No** (provider identity is not on the facade)                                                                                                                                               |
| `apps/bench/lunora/payment/index.ts:427`     | same capability check (copy of the template)                                           | **No**                                                                                                                                                                                        |
| `apps/bench/lunora/payment/index.ts:430`     | same identifier read                                                                   | **No**                                                                                                                                                                                        |

These are read-only metadata, not provider operations, but no facade member answers them. Per the
owner's rule, this plan stops here for a decision rather than invent facade surface.

### 1.2 Library and generated surface

- `packages/payment/src/create-payment.ts:193`: `readonly adapter: PaymentAdapter;` in
  `interface LunoraPayment` (remove). `:470`: `adapter,` in the object `createPayment` returns
  (remove). `:169` is `CreatePaymentOptions.adapter`, the input, and **stays**.
- `packages/payment/src/context.ts:109`: passes `options.adapter` into `createPayment`. This is
  the input, so it **stays**.
- `api-snapshots/payment.api.md:216`: `readonly adapter: PaymentAdapter;` inside
  `interface LunoraPayment` (remove that line only; the other `readonly adapter` lines at `:118`,
  `:504`, `:553` belong to option types and stay).
- Codegen emitters and golden fixtures, every `_generated/` output, `@lunora/testing`, the
  framework adapters (react, vue, svelte, solid, angular, nuxt, astro), `registry/payment`
  (comments only) and `tests/*`: **no reference**. `PAYMENT_METHODS` lists callable members
  only, so the generated stub never had `adapter`.

### 1.3 Docs and the docs guard

- `packages/payment/docs/index.mdx:278-283`: warn callout that describes `ctx.payments.adapter`
  as exposed for provider-specific extras. Rewrite: the adapter is not reachable from
  `ctx.payments`; every money and subscription operation goes through the facade.
- `packages/payment/docs/polar.mdx:427`: "Go through the facade, not `ctx.payments.adapter.refundPayment`".
  Already covered by `refundPayment`; reword so it no longer names a property that does not exist.
- `packages/payment/__tests__/docs.test.ts:28-48`: the guard currently fails only on a _call_ of
  certain adapter methods. Retarget it to fail on any `ctx.payments.adapter` mention in the docs.
- creem, dodopayments, autumn and stripe docs mention "the adapter" only in prose about wiring
  `payment(env)`. No change.

## 2. Existing seams

The facade already wraps every money and subscription operation: `createCheckout`, `attach`,
`refundPayment`, `capturePayment`, `cancelPayment`, `cancelSubscription`, `updateSubscription`,
`resumeSubscription` and `createPortalSession`. The adapter's capabilities are read inside the
facade at `create-payment.ts:321`.

## 3. Contract to preserve

Every facade method behaves as today. `createPayment({ adapter, … })` and
`paymentsFromContext(ctx, { adapter, … })` keep their input.

## 4. Design decisions

1. Remove the property; keep the input option. Rejected: deprecate first (alpha branch, no
   compatibility shims).
2. **Call sites in §1.1: owner fork, not decided here.**
    - (a) Add a read-only, non-operational member to the facade, e.g.
      `readonly provider: { identifier: ProviderId; capabilities: ProviderCapabilities }`, and
      switch both call sites to `ctx.payments.provider.*`. This is new public surface (snapshot,
      docs table, codegen stub test unaffected since it is not callable).
    - (b) Drop the pre-check in both call sites and rely on the facade's `PROVIDER_ERROR` from
      `createCheckout`, releasing the checkout hold when that error is thrown. This changes the
      template's deliberate ordering and needs a test that the hold is released.
    - (c) Derive the capability in app code from the adapter the app builds in its own
      `payment(env)` thunk (e.g. a module constant next to the `createShardDO` config). No library
      change, but the check can drift from the configured provider.

## 5. Workstreams (to execute once §4.2 is decided)

1. Remove `adapter` from `interface LunoraPayment` and from the returned object.
2. Hand-edit `api-snapshots/payment.api.md` (remove line `:216` only); reviewer runs
   `build:packages` + `api:check`.
3. Rewrite the `index.mdx` callout and the `polar.mdx:427` sentence; retarget the
   `docs.test.ts` guard to `/ctx\.payments\.adapter\b/` (red first: it fails on the current docs).
4. Apply the owner's option to `templates/saas/lunora/payment/index.ts` and
   `apps/bench/lunora/payment/index.ts`.
5. Gates: `lint:types`, `lint:eslint` and tests for `@lunora/payment`; the bench app's
   `lint:types`; `pnpm run test:templates` for the saas template (reviewer runs it, one at a
   time); the reviewer regenerates `examples/payment-demo` and confirms no drift.

Commit body must carry: `BREAKING CHANGE: LunoraPayment no longer exposes the provider adapter;
use the facade methods.`

## 6. Platform parity

No `ctx.*` surface is added; one property (`ctx.payments.adapter`) is removed from an existing
surface. The `PlatformCapabilities` rating for payments is unchanged.

## 7. Phasing & ordering

| Phase | Work                              | Gate                                                                            |
| ----- | --------------------------------- | ------------------------------------------------------------------------------- |
| 0     | owner decides §4.2                | decision recorded in §9.1                                                       |
| 1     | red docs guard                    | `docs.test.ts` fails on `index.mdx` / `polar.mdx`                               |
| 2     | remove property, docs, call sites | payment tests, types, lint; bench types                                         |
| 3     | reviewer                          | `build:packages` + `api:check`; `test:templates`; example regenerated, no drift |

## 8. Risks & STOP conditions

- **STOP** if `lint:types` anywhere finds another reader of `.adapter` on a `LunoraPayment`.
- **STOP** if option (b) is chosen and the hold cannot be released without a schema change.

## 9. Open questions

1. **Owner:** which option for the two call sites in §1.1: (a), (b) or (c)?
