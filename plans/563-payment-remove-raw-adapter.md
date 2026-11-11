# Plan 563 — Replace `ctx.payments.adapter` with a read-only `ctx.payments.provider`

> **Executor instructions.** Follow this plan step by step. Run every `Verify:` command and
> confirm the expected result before moving on. Touch only the files listed under "In scope".
> If any STOP condition occurs, stop and report; do not improvise. Do not update
> `plans/README.md`. **Every change is a new commit on top of the branch: never amend, rebase or
> force-push.**
>
> **Drift check (run first):** `git log --oneline -1` must start with `a57c2b565`. Anything else is
> a STOP condition.

**Baseline:** `a57c2b565`, tip of `security/improve-559-payment-subscription-facade` (PR #1544).
This plan is the addendum to plan 559 and adds commits on that branch.
**Status:** TODO (unblocked 2026-11-11: owner chose option (a), §9.1)
**Priority / Effort / Risk:** P1 / S / LOW. **Category:** security. **Depends on:** plan 559.

## 0. Headline finding

`LunoraPayment` exposes `readonly adapter: PaymentAdapter`, so app code can call any provider
operation (refund, capture, cancel, update, resume) with a bare id and no `authorize` check. The
owner decided to remove it. Two call sites need the provider's identity and capabilities before
they start a checkout, so the owner also decided to add a read-only `ctx.payments.provider` that
exposes only `{ identifier, capabilities }`: no operations, and no path back to the adapter object.

## 1. Current state (audit), every use of `.adapter` on the payments context

Searched `packages/*`, `examples/*`, `templates/*`, `registry/*`, `apps/*`, `tests/*`, `sdks/*`,
every `_generated/` tree and every payment doc at `a57c2b565`.

### 1.1 Real call sites

- `templates/saas/lunora/payment/index.ts:316-323`:

    ```ts
    // The hold below stops a second purchase only because the provider expires
    // the first session when the hold ends. A provider that cannot is refused
    // here, before a hold is taken, rather than by the facade after it.
    if (!ctx.payments.adapter.capabilities.checkoutExpiry) {
        throw new LunoraError(
            "NOT_IMPLEMENTED",
            `checkout needs a payment provider that can expire a session (capabilities.checkoutExpiry); ${ctx.payments.adapter.identifier} cannot`,
        );
    }
    ```

- `apps/bench/lunora/payment/index.ts:424-431`: the same block (a copy of the template).

Neither file is generated from another. No `scripts/sync-*` covers them, so `lint:registry:sync`
does not apply.

### 1.2 Library and generated surface

- `packages/payment/src/create-payment.ts:193`: `readonly adapter: PaymentAdapter;` is the first
  member of `interface LunoraPayment`. Remove it. Members are alphabetical, so `provider` goes
  between `listSubscriptions` and `refundPayment`.
- `create-payment.ts:470`: `adapter,` is the first key of the object `createPayment` returns. Remove it.
- `create-payment.ts:169` (`CreatePaymentOptions.adapter`) and `context.ts:109` are the input
  option, and **stay**. `createPayment` keeps using `adapter` privately.
- `ProviderCapabilities` (`types.ts:34-46`: `checkoutExpiry?`, `merchantOfRecord`, `portal`,
  `usageMetering`, all `readonly`) and `ProviderId` are already exported from `@lunora/payment`.
- `api-snapshots/payment.api.md:216`: `readonly adapter: PaymentAdapter;` inside
  `interface LunoraPayment`. Lines `:118`, `:504` and `:553` belong to option types and stay.
- Codegen `PAYMENT_METHODS`, the generated `paymentStub` and `codegen-stub.test.ts` list callable
  members only. `provider` is not callable, so none of them change. The `docs.test.ts` table test
  parses `name: (` members only, so it is unaffected too.
- No reference in codegen fixtures, `@lunora/testing`, the framework adapters, `registry/payment`
  or `tests/*`.

### 1.3 Docs and the docs guard

- `packages/payment/docs/index.mdx:277-283`: a warn callout that presents `ctx.payments.adapter` as
  available for "provider-specific extras".
- `packages/payment/docs/polar.mdx:426-430`: "Go through the facade, not `ctx.payments.adapter.refundPayment`."
- `packages/payment/__tests__/docs.test.ts:26-50`: the guard "never documents a money operation on
  ctx.payments.adapter" fails only on _calls_ of certain adapter methods.

## 2. Existing seams

`createPayment` in `create-payment.ts`; test helpers `fakeAdapter`, `subscription` and
`MemoryPaymentStore` in `__tests__/create-payment.test.ts`. `fakeAdapter()` has
`capabilities: { checkoutExpiry: true, merchantOfRecord: false, portal: true, usageMetering: true }`
and `identifier: "stripe"`. `startCheckout` refuses `expiresAt` when
`!adapter.capabilities.checkoutExpiry` (`create-payment.ts:321`).

## 3. Contract to preserve

Every facade method behaves as today. `createPayment({ adapter, … })` and
`paymentsFromContext(ctx, { adapter, … })` keep their input. Both call sites keep refusing
_before_ the checkout hold is taken.

## 4. Design decisions

1. **Owner decision (2026-11-11), option (a):** remove `adapter` from `LunoraPayment`, and add

    ```ts
    /**
     * Who the provider is and what it supports, for checks an app makes before it starts an
     * operation (e.g. refusing a checkout that needs session expiry before taking a hold).
     * Read-only data: no operation and no reference to the adapter is reachable from it.
     */
    readonly provider: { readonly capabilities: ProviderCapabilities; readonly identifier: ProviderId };
    ```

2. **Build it once, frozen, from copies:**
   `const provider = Object.freeze({ capabilities: Object.freeze({ ...adapter.capabilities }), identifier: adapter.identifier });`.
   It is a plain object holding a copied capabilities object, so nothing on it points at the
   adapter, and mutating it throws in strict mode without affecting the facade. Rejected: getters
   over `adapter.capabilities`. They would hand out the adapter's own capabilities object, which
   is mutable.
3. **No new named exported type.** The member uses the existing exports `ProviderCapabilities` and `ProviderId`.
4. **The codegen stub is unchanged.** With no payment configured, `ctx.payments.provider` is
   `undefined`, exactly as `ctx.payments.adapter` was.

## 5. Workstreams

Single workstream (S), in the steps below.

## 6. Platform parity

One property (`ctx.payments.adapter`) is removed from an existing surface. One read-only property
(`ctx.payments.provider`) is added; it is plain data copied from the configured adapter, with no
host-backed behaviour and no binding. The `PlatformCapabilities` rating for payments is unchanged,
and no new `ctx.*` surface is introduced.

## 7. Phasing & ordering

| Phase | Work                               | Gate                                                                                  |
| ----- | ---------------------------------- | ------------------------------------------------------------------------------------- |
| 0     | install, build                     | `pnpm --filter "@lunora/payment..." run build`                                        |
| 1     | red tests                          | new facade tests and the retargeted docs guard fail                                   |
| 2     | facade, call sites, docs, snapshot | payment tests, types, lint                                                            |
| 3     | reviewer                           | `build:packages` + `api:check`; bench `lint:types`; example regenerated with no drift |

## Commands you will need

Prefix every shell call with `cd <worktree> &&`.

| Purpose              | Command                                                                    | Expected           |
| -------------------- | -------------------------------------------------------------------------- | ------------------ |
| Install              | `pnpm install`                                                             | exit 0             |
| Build payment + deps | `pnpm --filter "@lunora/payment..." run build`                             | exit 0             |
| One test file        | `pnpm --filter "@lunora/payment" exec vitest run __tests__/<file>.test.ts` | all pass           |
| Package tests        | `pnpm --filter "@lunora/payment" run test`                                 | all pass           |
| Types                | `pnpm --filter "@lunora/payment" run lint:types`                           | exit 0             |
| Format code          | `pnpm exec oxfmt <changed .ts files>`                                      | exit 0             |
| Format docs          | `pnpm exec prettier --write <changed .mdx files>`                          | exit 0             |
| Lint (after format)  | `pnpm --filter "@lunora/payment" run lint:eslint`                          | exit 0, 0 warnings |

**Forbidden:** `pnpm run build`, `pnpm run build:packages`, root `pnpm run test`,
`pnpm run test:workerd`, `pnpm run test:templates`, `pnpm run api:check`, `pnpm run api:update`,
any `pnpm -r …`, and the bench app's `lint:types` (it runs the built CLI). Your reviewer runs those
that apply. workerd is not needed: no SQL, storage or Durable Object code changes.

## Scope

**In scope:**

- `packages/payment/src/create-payment.ts`
- `packages/payment/__tests__/create-payment.test.ts`
- `packages/payment/__tests__/docs.test.ts`
- `packages/payment/docs/index.mdx` (the callout below the `ctx.payments` table only)
- `packages/payment/docs/polar.mdx` (the callout at ~line 426 only)
- `templates/saas/lunora/payment/index.ts` (the capability check only)
- `apps/bench/lunora/payment/index.ts` (the capability check only)
- `api-snapshots/payment.api.md` (the `LunoraPayment` block only)

**Out of scope:** `adapter.ts`, `types.ts`, `context.ts`, providers, codegen and the generated
example, `codegen-stub.test.ts`, the other docs pages, `CHANGELOG.md`, `plans/**`.

## Git workflow

- Branch `security/improve-559-payment-subscription-facade` (already checked out at `a57c2b565`).
  New commits only; never `--amend`, rebase, force, `--no-verify`, push, or open a PR.
- Stage explicit paths only.
- Message (header ≤ 100, body lines ≤ 100):

    ```
    security(payment): replace ctx.payments.adapter with read-only provider info

    The facade no longer hands out the provider adapter, so no money or subscription operation
    can bypass its ownership check. ctx.payments.provider exposes the provider's identifier and
    capabilities as frozen copies, for checks an app makes before it starts an operation. The
    saas template and the bench app use it for their pre-checkout capability check.

    BREAKING CHANGE: LunoraPayment.adapter is removed; use the facade methods, and
    ctx.payments.provider for the provider's identifier and capabilities.
    ```

    Add any attribution trailer your environment requires, after a blank line.

- If the pre-commit hook fails, fix the reported problem in an in-scope file and commit again;
  twice for a reason outside scope → STOP.

## Steps

### Step 1: Install and build

`pnpm install`; `pnpm --filter "@lunora/payment..." run build`.
**Verify:** exit 0; `git log --oneline -1` starts with `a57c2b565`.

### Step 2: Red tests

In `packages/payment/__tests__/create-payment.test.ts`, add a top-level
`describe("createPayment — provider info", …)` at the end of the file (`expect.assertions(n)` in
each test):

1. "exposes the configured provider's identifier and capabilities": with
   `createPayment({ adapter: fakeAdapter(), authorize: () => true, store: new MemoryPaymentStore() })`,
   `payment.provider` strictly equals
   `{ capabilities: { checkoutExpiry: true, merchantOfRecord: false, portal: true, usageMetering: true }, identifier: "stripe" }`.
2. "does not hand out the adapter": `"adapter" in payment` is `false`; no value in
   `Object.values(payment)` is the adapter object (`toBe` the one passed in); `payment.provider.capabilities`
   is not the adapter's own `capabilities` object (`not.toBe`); and no value of `payment.provider`
   is a function.
3. "is frozen, and changing it does not change what the facade does": `Object.isFrozen(payment.provider)`
   and `Object.isFrozen(payment.provider.capabilities)` are `true`. Assigning
   `(payment.provider.capabilities as { checkoutExpiry?: boolean }).checkoutExpiry = false` inside
   `expect(() => …).toThrow(TypeError)` throws. Afterwards a `createCheckout` with
   `expiresAt: Date.now() + 60_000` (other fields as in the file's first checkout test) still
   resolves, because the facade reads the adapter, not the copy.

In `packages/payment/__tests__/docs.test.ts`, retarget the guard: rename the test to
`"never mentions ctx.payments.adapter, which the facade no longer exposes"`, change the regex to
`/ctx\.payments\.adapter\b/`, drop the "A call, not a mention" comment, and update the docblock to
say the property was removed and every money and subscription operation goes through the facade.

**Verify (RED):** `pnpm --filter "@lunora/payment" exec vitest run __tests__/create-payment.test.ts __tests__/docs.test.ts`.
The three provider tests fail (type errors count), and the docs guard fails, listing
`index.mdx` and `polar.mdx`. Existing tests pass. Record the output.

### Step 3: Facade

In `create-payment.ts`: import `ProviderCapabilities` and `ProviderId` as types if not already
imported (keep the list sorted). Remove `readonly adapter: PaymentAdapter;` from the interface, and
add the `provider` member of §4.1 between `listSubscriptions` and `refundPayment`. In
`createPayment`, build `provider` per §4.2, before the `return`. In the returned object, remove
`adapter,` and add `provider,` in alphabetical position. Keep the `PaymentAdapter` import if
`CreatePaymentOptions` still uses it.

**Verify:** `pnpm --filter "@lunora/payment" exec vitest run __tests__/create-payment.test.ts`
passes; `pnpm --filter "@lunora/payment" run lint:types` exits 0.

### Step 4: Call sites

In both `templates/saas/lunora/payment/index.ts` and `apps/bench/lunora/payment/index.ts`, replace
`ctx.payments.adapter.capabilities.checkoutExpiry` with `ctx.payments.provider.capabilities.checkoutExpiry`
and `ctx.payments.adapter.identifier` with `ctx.payments.provider.identifier`. Change nothing else.
The check stays where it is, before the hold.

**Verify:** `grep -rnE "payments\.adapter\b" templates apps packages examples registry tests --include='*.ts' --include='*.tsx' --include='*.mdx' --include='*.md'`
(excluding `node_modules`, `dist` and `CHANGELOG.md`) prints nothing except the docs lines Step 5
fixes.

### Step 5: Docs

- `index.mdx` callout below the `ctx.payments` table: replace it with a callout saying the
  provider adapter is not reachable from `ctx.payments`: every money and subscription operation
  goes through the facade methods above, which authorize the caller and write the store.
  `ctx.payments.provider` gives the provider's `identifier` and `capabilities` (read-only) for
  checks an app makes before starting an operation; show the `checkoutExpiry` check as a one-line
  example.
- `polar.mdx` callout at ~line 426: start with "Refund through `ctx.payments.refundPayment`."
  instead of naming the adapter; keep the rest.
- Prettier on both files.

**Verify:** `pnpm --filter "@lunora/payment" exec vitest run __tests__/docs.test.ts` passes, and
`grep -rn "payments.adapter" packages/payment/docs` prints nothing.

### Step 6: API snapshot

In `api-snapshots/payment.api.md`, inside `interface LunoraPayment {`, delete the line
`    readonly adapter: PaymentAdapter;`, and insert after the `listSubscriptions` line:

```text
    readonly provider: {
        readonly capabilities: ProviderCapabilities;
        readonly identifier: ProviderId;
    };
```

Change nothing else. (The reviewer confirms the printed form with `api:check` and will send the
exact diff if it differs.)

**Verify:** `git diff -- api-snapshots/payment.api.md` shows one line removed and four added.

### Step 7: Gates

oxfmt on changed `.ts` files; `lint:types`, `lint:eslint`, `pnpm --filter "@lunora/payment" run test`.
**Verify:** each exits 0.

### Step 8: Commit (new commit)

**Verify:** `git status --porcelain` empty; `git log --oneline a57c2b565..HEAD` shows the new
commit; `git diff --stat a57c2b565..HEAD` lists only in-scope files.

## Done criteria

- [ ] `pnpm --filter "@lunora/payment" run test`, `lint:types`, `lint:eslint` exit 0
- [ ] `grep -rn "readonly adapter: PaymentAdapter" packages/payment/src/create-payment.ts` prints only the `CreatePaymentOptions` line
- [ ] no `payments.adapter` left in code or docs (Step 4/5 greps)
- [ ] `git diff --stat a57c2b565..HEAD` lists only in-scope files; history not rewritten
- [ ] Reviewer: `build:packages` + `api:check`; `pnpm --filter "@lunora/bench" run lint:types`; example regenerated with no drift

## 8. Risks & STOP conditions

- **STOP** if `lint:types` finds another reader of `.adapter` on a `LunoraPayment` outside scope.
- **STOP** if any existing test fails after the change.
- **STOP** if a step's verification fails twice.
- **Coverage gap:** `templates/saas` has no gate an executor can run (`test:templates` installs the
  template from scratch). The bench copy is the same code, and the reviewer type-checks it.

## 9. Open questions

1. **Decided 2026-11-11 by the owner: option (a)**, a read-only `ctx.payments.provider` with
   `{ identifier, capabilities }` and no route to the adapter, replacing `ctx.payments.adapter`.
   The rejected options were (b) dropping the pre-check and relying on the facade error, and
   (c) deriving the capability in app config.
