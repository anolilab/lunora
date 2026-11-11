# Plan 559 — Add ownership-checked `updateSubscription` and `resumeSubscription` to the payment facade

> **Executor instructions.** Follow this plan step by step. Run every `Verify:` command and
> confirm the expected result before moving on. Touch only the files listed under "In scope".
> If any STOP condition occurs, stop and report; do not improvise. Do not update
> `plans/README.md` (your reviewer maintains it).
>
> **Drift check (run first):**
> `git diff --stat 36c32cc1b..HEAD -- packages/payment/src/create-payment.ts packages/payment/src/types.ts packages/payment/__tests__/create-payment.test.ts packages/payment/__tests__/docs.test.ts packages/payment/__tests__/codegen-stub.test.ts packages/payment/docs packages/codegen/src/emit/shard-runtime.ts examples/payment-demo/lunora/_generated/shard.ts api-snapshots/payment.api.md`
> Expected: no output. Any change means comparing the excerpts in §1 with the live code;
> a mismatch is a STOP condition.

**Baseline:** `36c32cc1b` (2026-11-11)
**Status:** TODO
**Priority / Effort / Risk:** P1 / M / LOW. **Category:** security. **Depends on:** none.
**Finding:** audit 2026-11-11, row 33. (Row 34, same-state subscription events, is a different
finding and is **not** part of this plan.)

## 0. Headline finding

`ctx.payments` (the `LunoraPayment` facade) authorizes the caller against the subscription's
owner for `cancelSubscription`, but has no `updateSubscription` (plan or seat change) and no
`resumeSubscription` (undo a period-end cancel). The docs tell apps to call
`ctx.payments.adapter.updateSubscription(subscriptionId, …)` and
`ctx.payments.adapter.resumeSubscription(subscriptionId)` instead. The adapter methods take a
bare subscription id, run no `authorize` check and write nothing to the store. An app that
follows the docs and takes the id from its caller lets one customer change or resume another
customer's subscription. Cancel-at-period-end is also a one-way door on the facade: its undo
exists only on the raw adapter.

## 1. Current state (audit)

### The facade, `packages/payment/src/create-payment.ts` (821 lines)

- `:191-245`: `export interface LunoraPayment`. Members are in alphabetical order. Method
  members use the `name: (args) => Result;` form, which two tests parse with a regex. Current
  methods: `attach, cancelPayment, cancelSubscription, capturePayment, check, createCheckout,
createPortalSession, handleWebhook, listBalances, listSubscriptions, refundPayment, track`.
  Properties: `readonly adapter`, `readonly store`.
- `:271-288`: `ensureAuthorized(referenceId)` throws `FORBIDDEN` unless the app's
  `authorize` returns exactly `true`.
- `:293-298`: `outboundKey(operation, scope, key, parts)` gives
  `derivedIdempotencyKey(operation, adapter.identifier, ...scope, ...(key === undefined ? parts() : [key]))`.
- `:116-125`: `requireQuantity(method, value)` validates a non-negative safe integer and turns
  `undefined` into `1`.
- `:427-478`, `cancelSubscription`, is the pattern to follow:

    ```ts
    cancelSubscription: async (subscriptionId, cancelOptions) => {
        const existing = await store.getSubscription(adapter.identifier, subscriptionId);

        // Collapse "doesn't exist" and "not yours" into one indistinguishable NOT_FOUND so the
        // endpoint can't be used as a cross-tenant existence oracle. A non-owner authorizer denial
        // is rewritten to the same 404 as a genuinely missing id.
        if (!existing) {
            throw new LunoraPaymentError("NOT_FOUND", `subscription "${subscriptionId}" not found`);
        }

        try {
            await ensureAuthorized(existing.referenceId);
        } catch {
            throw new LunoraPaymentError("NOT_FOUND", `subscription "${subscriptionId}" not found`);
        }
        // … done-check, outboundKey("cancel_subscription", …), adapter call …
        const synced = overlayProviderSubscription(existing, await adapter.cancelSubscription(subscriptionId, { ...cancelOptions, idempotencyKey: key }));
        const policy = options.singleSubscriptionPerReference ?? false;
        let outcome = await storeSubscription(store, policy, existing, synced, { ifRevision: existing.revision });
        if (outcome === "rejected") { /* re-read and merge via recordCancelAnswer, else INVALID_TRANSITION */ }
        if (outcome === "refused") {
            notifyObserver(options.observability, { provider: synced.provider, subscriptionId: synced.id, type: "subscription.duplicate" });
        }
        return (await store.getSubscription(adapter.identifier, subscriptionId)) ?? synced;
    },
    ```

### The adapter contract, `packages/payment/src/adapter.ts:94-99`

```ts
resumeSubscription: (subscriptionId: string, options?: { idempotencyKey?: string }) => Promise<Subscription>;
updateSubscription: (subscriptionId: string, patch: SubscriptionPatch) => Promise<Subscription>;
```

`SubscriptionPatch` (`packages/payment/src/types.ts:372-390`) is
`{ idempotencyKey?, priceId?, proration?, quantity? }`. Its docblock **forbids a derived
default key**: "Omitted, the update is sent un-keyed: it sets an ABSOLUTE price/quantity, so a
retry of an applied change is a no-op, whereas a key derived from the target would make
A → B → A inside Stripe's 24h window replay the first A response and leave the subscription
on B." The Stripe `resumeSubscription` (`providers/stripe.ts:617-630`) says the same for
resume (cancel → resume → cancel → resume inside 24h).

**"Resume" means different things per provider.** Stripe, Polar and Dodo clear
`cancelAtPeriodEnd`. Creem (`providers/creem.ts:460-464`) calls `subscriptions.resume`, which
resumes a **paused** subscription. The facade must therefore not decide when a resume is a
no-op; it always calls the adapter.

### Every surface that mirrors `LunoraPayment`

- `packages/codegen/src/emit/shard-runtime.ts:763-777`: `const PAYMENT_METHODS = [ … ] as const;`,
  an alphabetical list of every callable member. It renders the throwing `paymentStub` in each
  generated `_generated/shard.ts`.
- `examples/payment-demo/lunora/_generated/shard.ts:181-218`: the committed output of that
  emitter. CI's `generated-files` job (`.github/workflows/lint.yml`, "Lint (generated files)")
  regenerates it and fails on any byte difference. Each member renders exactly as:

    ```ts
        refundPayment: () => {
            throw new Error("ctx.payments: no payment configured. Pass `payment` to createShardDO().");
        },
    ```

- `packages/payment/__tests__/codegen-stub.test.ts:11-24`: a `METHODS` object
  `satisfies Record<CallableKey, true>`. It fails `tsc` as soon as the interface gains a method
  it does not list. Its test compares the stub in the generated example against it.
- `packages/payment/__tests__/docs.test.ts`:
    - "lists every facade method in the overview's ctx.payments table" requires a row containing
      `` `<name>( `` in `packages/payment/docs/index.mdx` for each interface method.
    - "never documents a money operation on ctx.payments.adapter" (around line 34) fails on any
      docs page matching `/ctx\.payments\.adapter\.(?:cancel|capture|refund)Payment\(/`.
- `api-snapshots/payment.api.md:212-235`: the printed `LunoraPayment` interface (excerpt
  below). `api:check` compares the built `.d.ts` against it.

    ```ts
    interface LunoraPayment {
        readonly adapter: PaymentAdapter;
        attach: (input: AttachInput) => Promise<CheckoutResult>;
        …
        refundPayment: (input: RefundInput) => Promise<PaymentSession>;
        readonly store: PaymentStore;
        track: (input: TrackInput) => Promise<TrackResult>;
    }
    ```

### Docs that send apps to the raw adapter

- `packages/payment/docs/index.mdx:255-273`: the `ctx.payments` method table. `:275-280`: a
  warn callout that says the adapter is "exposed for the surfaces the facade does not wrap
  (`updateSubscription`, `resumeSubscription`, …)".
- `packages/payment/docs/creem.mdx:247`, `:261`: `ctx.payments.adapter.updateSubscription(subscriptionId, …)`;
  `:268-273`: "Resume a paused subscription through the adapter" plus
  `ctx.payments.adapter.resumeSubscription(subscriptionId)`.
- `packages/payment/docs/dodopayments.mdx:262-263`: `ctx.payments.adapter.updateSubscription(…)`.
- `packages/payment/docs/autumn.mdx:430-445` describes what the Autumn adapter does internally
  and has no `ctx.payments.adapter.` call. Leave it.

Nothing outside `packages/payment`, `packages/codegen` and the example mentions these methods
on the facade (Studio, MCP, CLI, registry, templates and the SDKs were grepped).

## 2. Existing seams (do not reinvent)

- `ensureAuthorized`, `outboundKey`, `requireQuantity`, `overlayProviderSubscription`
  (`./store`), `storeSubscription` (`./subscription-policy`) and `notifyObserver`
  (`./observability`), all already imported or defined in `create-payment.ts`.
- Test helpers in `packages/payment/__tests__/create-payment.test.ts`: `subscription(referenceId, state)`
  (line 16), `fakeAdapter(overrides)` (line 44, already stubs `resumeSubscription` and
  `updateSubscription`), `MemoryPaymentStore`, `derivedIdempotencyKey` (already imported).
  The "racing" store (around lines 624-684: `Object.assign(Object.create(store), { upsertSubscription … })`)
  is the pattern for simulating a webhook landing during the provider call.

## 3. The behavioural contract to preserve

- `cancelSubscription` behaves exactly as today; all its existing tests pass unchanged.
- Unknown id and non-owner give the **same** `NOT_FOUND` error with the same message, on every
  subscription method, so there is no cross-tenant existence oracle.
- No derived idempotency key for update or resume: with no caller key the adapter receives
  `idempotencyKey: undefined`.
- `ctx.payments.adapter` stays on the interface (removing it is a separate decision; see §9).

## 4. Design decisions

1. **Add two facade methods** with the adapter's own signatures:
   `updateSubscription(subscriptionId, patch: SubscriptionPatch)` and
   `resumeSubscription(subscriptionId, options?: { idempotencyKey?: string })`.
   Rejected: a single `changeSubscription` that merges both. That doesn't match the adapter
   vocabulary the docs already use.
2. **One ownership helper.** Add `ownedSubscription(subscriptionId)` inside `createPayment`.
   It reads the row, collapses missing/not-owner into the identical `NOT_FOUND`, and returns
   the row. `cancelSubscription` switches to it too, so the three methods cannot drift apart.
   Rejected: copying the block three times.
3. **Caller key only, namespaced.** When the caller passes a key, forward
   `await outboundKey("update_subscription" | "resume_subscription", [subscriptionId], key, () => [])`.
   With a key given, that is `derivedIdempotencyKey(operation, provider, subscriptionId, key)`,
   so one tenant cannot replay another's key. With no key, forward `undefined`. Rejected:
   always deriving a key, as cancel does. The type docs forbid it (A → B → A replay).
4. **Validate `patch.quantity` on the facade** with `requireQuantity("updateSubscription", patch.quantity)`
   **only when it is defined**. A negative or non-integer seat count is refused before any
   provider call, uniformly across providers. A missing quantity stays missing; do not turn it
   into `1`.
5. **No no-op short-circuit for resume.** Creem's resume acts on paused subscriptions and the
   others' on `cancelAtPeriodEnd`. Always call the adapter.
6. **Store the answer through the policy.** Use
   `storeSubscription(store, policy, existing, overlayProviderSubscription(existing, answer), { ifRevision: existing.revision })`.
    - `"refused"`: notify the observer with `subscription.duplicate`, the same as cancel.
    - `"rejected"`: a webhook moved the row during the provider call. Throw
      `new LunoraPaymentError("INVALID_TRANSITION", "the subscription changed while it was being updated; the provider has accepted the change, so retry or reconcile this subscription")`
      (resume uses the same message with "resumed"). A retry is safe because both calls set
      absolute state. Rejected alternative: the merge-and-retry loop of `recordCancelAnswer`.
      Cancel needs that loop because a cancel must never be lost silently. An update has no
      such field to merge onto the newer row, and the provider's own event for the change
      follows anyway.
    - Return `(await store.getSubscription(adapter.identifier, subscriptionId)) ?? synced`.
      Put this in one private helper used by both methods.
7. **Docs move to the facade.** Every `ctx.payments.adapter.updateSubscription(` and
   `ctx.payments.adapter.resumeSubscription(` example becomes `ctx.payments.…`. The docs guard
   test is extended so they cannot come back.

## 5. Workstreams

Single workstream (M), in the steps below.

## 6. Platform parity

Not applicable to the capability matrix. The plan adds two methods to the existing
`ctx.payments` surface. It is library code over `ctx.db` and the provider SDK, so its
`PlatformCapabilities` rating is unchanged. The codegen stub (the generated-output mirror of
this surface) is updated in Step 6.

## 7. Phasing & ordering

| Phase | Work                                                            | Gate                                                                                                           |
| ----- | --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| 0     | install, build                                                  | `pnpm install`; `pnpm --filter "@lunora/payment..." run build`; `pnpm --filter "@lunora/codegen..." run build` |
| 1     | tests first (red)                                               | new facade tests fail; docs guard fails on creem/dodo                                                          |
| 2     | facade + interface                                              | `create-payment.test.ts` green                                                                                 |
| 3     | mirrors (codegen list, generated stub, stub test, API snapshot) | `codegen-stub.test.ts` green                                                                                   |
| 4     | docs                                                            | `docs.test.ts` green                                                                                           |
| 5     | gates                                                           | lint and types for payment and codegen; package tests                                                          |

## Commands you will need

Run every command from the worktree root you were given (prefix each shell call with
`cd <worktree> &&`).

| Purpose               | Command                                                                                                 | Expected on success      |
| --------------------- | ------------------------------------------------------------------------------------------------------- | ------------------------ |
| Install               | `pnpm install`                                                                                          | exit 0 (several minutes) |
| Build payment + deps  | `pnpm --filter "@lunora/payment..." run build`                                                          | exit 0                   |
| Build codegen + deps  | `pnpm --filter "@lunora/codegen..." run build`                                                          | exit 0                   |
| One payment test file | `pnpm --filter "@lunora/payment" exec vitest run __tests__/<file>.test.ts`                              | all pass                 |
| Payment tests         | `pnpm --filter "@lunora/payment" run test`                                                              | all pass                 |
| Codegen emitter tests | `pnpm --filter "@lunora/codegen" exec vitest run __tests__/run-codegen.test.ts`                         | all pass                 |
| Types                 | `pnpm --filter "@lunora/payment" run lint:types` and `pnpm --filter "@lunora/codegen" run lint:types`   | exit 0                   |
| Format code           | `pnpm exec oxfmt <changed .ts files>`                                                                   | exit 0                   |
| Format docs           | `pnpm exec prettier --write <changed .mdx/.md files>`                                                   | exit 0                   |
| Lint (after format)   | `pnpm --filter "@lunora/payment" run lint:eslint` and `pnpm --filter "@lunora/codegen" run lint:eslint` | exit 0, 0 warnings       |

**Forbidden** (they crash the machine when several worktrees run them at once): `pnpm run build`,
`pnpm run build:packages`, `pnpm run test` at the repo root, `pnpm run test:workerd`,
`pnpm run api:check`, `pnpm run api:update`, any `pnpm -r …`. `api:check` needs every
package built, so your reviewer runs it. You hand-edit the snapshot in Step 7. The workerd
suite is not needed: no SQL, storage or Durable Object code changes.

## Scope

**In scope** (the only files you may modify):

- `packages/payment/src/create-payment.ts`
- `packages/payment/__tests__/create-payment.test.ts`
- `packages/payment/__tests__/codegen-stub.test.ts`
- `packages/payment/__tests__/docs.test.ts`
- `packages/payment/docs/index.mdx`
- `packages/payment/docs/creem.mdx`
- `packages/payment/docs/dodopayments.mdx`
- `packages/codegen/src/emit/shard-runtime.ts` (the `PAYMENT_METHODS` array only)
- `examples/payment-demo/lunora/_generated/shard.ts` (the `paymentStub` object only)
- `api-snapshots/payment.api.md` (the `LunoraPayment` interface block only)

**Out of scope** (do not touch):

- `packages/payment/src/adapter.ts`, `src/types.ts`, every `src/providers/*.ts`: the adapter
  contract is unchanged.
- `packages/payment/src/state-machine.ts`, `src/sync.ts`: row 34 of the audit, a separate plan.
- `packages/payment/docs/autumn.mdx`, `stripe.mdx`, `polar.mdx`: they make no adapter call
  for these methods.
- Removing `readonly adapter` from `LunoraPayment`: a separate decision (§9).
- Any other `_generated` tree, `CHANGELOG.md`, `plans/**`.

## Git workflow

- You are on branch `security/improve-559-payment-subscription-facade` in a dedicated
  worktree. Do not create or switch branches.
- Commit once at the end (or once per phase if you prefer), staging explicit paths only
  (`git add <paths>`; never `git add -A`, `git commit -a` or `git stash`).
- Message (header ≤ 100 chars, body lines ≤ 100 chars):

    ```
    security(payment): add owner-checked updateSubscription and resumeSubscription

    The facade now authorizes plan and seat changes and the undo of a period-end cancel
    against the subscription's owner, and records the provider's answer in the store. The
    docs no longer send these calls to ctx.payments.adapter.

    BREAKING CHANGE: LunoraPayment gains two required members; a hand-written object typed as
    LunoraPayment must implement them.
    ```

    Add any attribution trailer your own environment requires, after a blank line.

- The pre-commit hook formats and lints staged files and builds their deps. If it fails, fix the
  reported problem in an in-scope file and commit again. Never use `--no-verify`. If it fails
  twice for a reason outside the in-scope files, STOP.
- Do not push. Do not open a PR.

## Steps

### Step 1: Install and build

`pnpm install`, then `pnpm --filter "@lunora/payment..." run build`, then
`pnpm --filter "@lunora/codegen..." run build`.

**Verify:** all three exit 0.

### Step 2: Write the facade tests first

In `packages/payment/__tests__/create-payment.test.ts`, add
`describe("updateSubscription / resumeSubscription", …)` at the end of the top-level
`describe("createPayment", …)`. Use `expect.assertions(n)` in every test, as the file does.
Tests:

1. **Non-owner and unknown id are the same NOT_FOUND, and the provider is never called.**
   Store `subscription("user_2", "active")`. Build the adapter with
   `updateSubscription: vi.fn(...)` and `resumeSubscription: vi.fn(...)`, and
   `authorize: (r) => r === "user_1"`. For each method, assert that `"sub_1"` and
   `"sub_absent"` both reject with `{ code: "NOT_FOUND" }` and that each message equals
   `` `subscription "<id>" not found` ``. Assert both `vi.fn`s were never called.
2. **Update changes the owner's plan and stores it.** Store `subscription("user_1", "active")`.
   The adapter `updateSubscription: async (id, patch) => ({ ...subscription("user_1", "active"), id, priceId: patch.priceId ?? "price_1" })`.
   Call `payment.updateSubscription("sub_1", { priceId: "price_2" })`. Assert the result and
   `store.getSubscription("stripe", "sub_1")` both have `priceId: "price_2"`.
3. **No derived key without a caller key; a namespaced key with one.** Capture the patch the
   adapter receives. With no key, assert `received.idempotencyKey` is `undefined`. With
   `{ priceId: "price_2", idempotencyKey: "k1" }`, assert it equals
   `await derivedIdempotencyKey("update_subscription", "stripe", "sub_1", "k1")`. Do the same
   for resume with `"resume_subscription"`.
4. **An invalid seat count is refused before the provider.** `updateSubscription("sub_1", { quantity: -1 })`
   rejects with `{ code: "VALIDATION_ERROR" }`; the adapter `vi.fn` was not called.
5. **Reverse state: cancel at period end, resume, cancel again.** Adapter:
   `cancelSubscription: vi.fn(async (id, o) => ({ ...subscription("user_1", "active"), id, cancelAtPeriodEnd: o?.atPeriodEnd === true }))`,
   `resumeSubscription: async (id) => ({ ...subscription("user_1", "active"), id, cancelAtPeriodEnd: false })`.
   Run `cancelSubscription("sub_1", { atPeriodEnd: true })` and assert the stored
   `cancelAtPeriodEnd` is `true`. Run `resumeSubscription("sub_1")` and assert it is `false`.
   Run `cancelSubscription("sub_1", { atPeriodEnd: true })` again and assert the stored value
   is `true` and the cancel `vi.fn` was called **twice**.
6. **A resume the single-subscription policy refuses is reported.** Use
   `singleSubscriptionPerReference: true` and `observability: vi.fn<PaymentObserver>()` (see the
   existing "keeps a past-due row past-due…" test for the observer shape). Store
   `{ ...subscription("user_1", "active"), id: "sub_2" }` and `subscription("user_1", "paused")`.
   The adapter resume returns `{ ...subscription("user_1", "active"), id }`. Assert
   `resumeSubscription("sub_1")` resolves, the observer was called with an object containing
   `{ type: "subscription.duplicate", subscriptionId: "sub_1" }`, and the stored `sub_1` state
   is not `"active"`.
7. **A row moved by a webhook during the call raises a conflict.** Copy the racing-store pattern
   from "raises a conflict rather than dropping a cancel…" (every guarded write returns `false`).
   Assert `updateSubscription("sub_1", { priceId: "price_2" })` rejects with
   `{ code: "INVALID_TRANSITION" }` and the stored row still has `priceId: "price_1"`.

**Verify (must be RED):**
`pnpm --filter "@lunora/payment" exec vitest run __tests__/create-payment.test.ts`. Every new
test fails (`payment.updateSubscription is not a function` or a type error) and every existing
test passes. Record the output.

### Step 3: Extend the docs guard first

In `packages/payment/__tests__/docs.test.ts`, change the regex in
"never documents a money operation on ctx.payments.adapter" to
`/ctx\.payments\.adapter\.(?:(?:cancel|capture|refund)Payment|(?:cancel|resume|update)Subscription)\(/`
and extend the docblock above it by one sentence: subscription changes also need the owner check
and the store write.

**Verify (must be RED):** `pnpm --filter "@lunora/payment" exec vitest run __tests__/docs.test.ts`
fails, listing `creem.mdx` and `dodopayments.mdx` as offenders.

### Step 4: Implement the facade

In `packages/payment/src/create-payment.ts`:

1. Import `SubscriptionPatch` as a type from `./types` (add it to the existing type import
   list; keep it sorted).
2. In `interface LunoraPayment`, add in alphabetical position: `resumeSubscription` after
   `refundPayment`, and `updateSubscription` after `track`. Use exactly the `name: (…) => …;`
   form. Each gets a short doc comment saying it is authorized against the subscription's
   owner, collapses unknown and not-owner into one `NOT_FOUND`, forwards only a caller-supplied
   idempotency key (why: the change is absolute, see `SubscriptionPatch`), and stores the
   provider's answer. The resume comment also says it clears a period-end cancel (Creem:
   resumes a paused subscription) and is the undo of `cancelSubscription({ atPeriodEnd: true })`.

    ```ts
    resumeSubscription: (subscriptionId: string, options?: { idempotencyKey?: string }) => Promise<Subscription>;
    updateSubscription: (subscriptionId: string, patch: SubscriptionPatch) => Promise<Subscription>;
    ```

3. Inside `createPayment`, next to `ownedSession`, add `ownedSubscription(subscriptionId)` as in
   §4.2. Replace the inline block at the top of `cancelSubscription` with it. The message and
   code must stay identical.
4. Add a private helper `recordSubscriptionAnswer(existing, answer, verb)` implementing §4.6
   (`verb` is `"updated"` or `"resumed"` for the conflict message).
5. Add the two methods to the returned object, in alphabetical position among the existing keys:

    ```ts
    resumeSubscription: async (subscriptionId, resumeOptions) => {
        const existing = await ownedSubscription(subscriptionId);
        const key = resumeOptions?.idempotencyKey === undefined ? undefined : await outboundKey("resume_subscription", [subscriptionId], resumeOptions.idempotencyKey, () => []);

        return recordSubscriptionAnswer(existing, await adapter.resumeSubscription(subscriptionId, { idempotencyKey: key }), "resumed");
    },
    ```

    `updateSubscription` is the same shape: `ownedSubscription`, then
    `if (patch.quantity !== undefined) requireQuantity("updateSubscription", patch.quantity);`,
    then the key, then
    `adapter.updateSubscription(subscriptionId, { ...patch, idempotencyKey: key })`, then
    `recordSubscriptionAnswer(…, "updated")`.

Comments say why, not what. No `.js` import extensions. No new exports.

**Verify:** `pnpm --filter "@lunora/payment" exec vitest run __tests__/create-payment.test.ts`
→ all pass, including the 7 new tests.

### Step 5: Codegen list and stub test

- `packages/codegen/src/emit/shard-runtime.ts`, `PAYMENT_METHODS`: insert `"resumeSubscription"`
  after `"refundPayment"` and `"updateSubscription"` after `"track"`.
- `packages/payment/__tests__/codegen-stub.test.ts`, `METHODS`: add `resumeSubscription: true`
  and `updateSubscription: true` in alphabetical position.

**Verify:** `pnpm --filter "@lunora/payment" exec vitest run __tests__/codegen-stub.test.ts`
→ FAILS (the generated example has not been updated yet). That is expected here.

### Step 6: The generated example stub

In `examples/payment-demo/lunora/_generated/shard.ts`, inside `const paymentStub: LunoraPayment = { … }`,
insert these two members. Keep the exact 4-space indentation and message text of the
neighbouring members:

- after the `refundPayment` member:

    ```ts
        resumeSubscription: () => {
            throw new Error("ctx.payments: no payment configured. Pass `payment` to createShardDO().");
        },
    ```

- after the `track` member (before the closing `} as unknown as LunoraPayment;`):

    ```ts
        updateSubscription: () => {
            throw new Error("ctx.payments: no payment configured. Pass `payment` to createShardDO().");
        },
    ```

Change nothing else in that file.

**Verify:** `pnpm --filter "@lunora/payment" exec vitest run __tests__/codegen-stub.test.ts` passes,
and `git diff --stat -- examples/payment-demo` shows exactly `+6` lines.

### Step 7: Hand-edit the API snapshot

In `api-snapshots/payment.api.md`, inside the `interface LunoraPayment {` block (around line
215), insert after the `refundPayment` line:

```
    resumeSubscription: (subscriptionId: string, options?: {
        idempotencyKey?: string;
    }) => Promise<Subscription>;
```

and after the `track` line:

```
    updateSubscription: (subscriptionId: string, patch: SubscriptionPatch) => Promise<Subscription>;
```

This is the printer's format; compare it with `PaymentAdapter`'s `resumeSubscription` /
`updateSubscription` lines in the same file. Change nothing else in the file.

**Verify:** `git diff -- api-snapshots/payment.api.md` shows only those 4 added lines.

### Step 8: Docs

- `packages/payment/docs/index.mdx`, in the `ctx.payments` table: add rows
  `` `updateSubscription(subscriptionId, patch)` `` → `Subscription` → "Change the plan
  (`priceId`) or seats (`quantity`) of the caller's own subscription; persists the result." and
  `` `resumeSubscription(subscriptionId, options?)` `` → `Subscription` → "Undo a period-end
  cancel (Creem: resume a paused subscription); persists the result." Place them next to
  `cancelSubscription`.
- The warn callout below the table: drop the claim that the facade does not wrap
  `updateSubscription` / `resumeSubscription`. Say the adapter is for provider-specific extras,
  and that calling it for anything the facade wraps (money and subscription operations) skips
  the caller authorization and the store write. Keep the existing money-operation sentences.
- `packages/payment/docs/creem.mdx`: the two `ctx.payments.adapter.updateSubscription(` calls
  become `ctx.payments.updateSubscription(`; the resume block becomes
  `await ctx.payments.resumeSubscription(subscriptionId); // → subscriptions.resume(id)` and its
  lead-in says "through the facade". Keep the explanatory comments about the provider call.
- `packages/payment/docs/dodopayments.mdx:262-263`: same change; the comment becomes
  "A plan and/or quantity change through the facade."
- Run Prettier on the three `.mdx` files.

**Verify:** `pnpm --filter "@lunora/payment" exec vitest run __tests__/docs.test.ts` passes, and
`grep -rnE "ctx\.payments\.adapter\.(update|resume)Subscription" packages/payment/docs` prints nothing.

### Step 9: Gates

Format the changed `.ts` files with oxfmt, then run `lint:types` and `lint:eslint` for
`@lunora/payment` and `@lunora/codegen`, then `pnpm --filter "@lunora/payment" run test` and
`pnpm --filter "@lunora/codegen" exec vitest run __tests__/run-codegen.test.ts`.

**Verify:** every command exits 0.

### Step 10: Commit

Stage exactly the in-scope files you changed and commit with the message above.

**Verify:** `git status --porcelain` is empty; `git diff --stat 36c32cc1b..HEAD` lists only
in-scope files.

## Test plan

- New: 7 tests in `create-payment.test.ts` (Step 2), modelled on the `cancelSubscription` tests
  in the same file (e.g. "rejects cancelling another caller's subscription as NOT_FOUND…" and
  the racing-store tests).
- Tightened guard: `docs.test.ts` regex (Step 3).
- Mirrors: `codegen-stub.test.ts` (Step 5/6) and the `index.mdx` table test.
- Red-without-fix: Steps 2 and 3 run before any implementation and must fail.

## Done criteria (all must hold)

- [ ] `pnpm --filter "@lunora/payment" run test` exits 0 (new tests included)
- [ ] `pnpm --filter "@lunora/codegen" exec vitest run __tests__/run-codegen.test.ts` exits 0
- [ ] `lint:types` and `lint:eslint` exit 0 for `@lunora/payment` and `@lunora/codegen`
- [ ] `grep -rnE "ctx\.payments\.adapter\.(update|resume)Subscription" packages/payment/docs` prints nothing
- [ ] `grep -c "Subscription: () => {" examples/payment-demo/lunora/_generated/shard.ts` prints `3`
- [ ] `git diff 36c32cc1b..HEAD -- api-snapshots/payment.api.md` adds exactly 4 lines and removes none
- [ ] `git diff --stat 36c32cc1b..HEAD` lists only in-scope files
- [ ] Reviewer only: `pnpm run build:packages && pnpm run api:check` passes on this branch

## 8. Risks & STOP conditions

- **STOP** if an existing `cancelSubscription` test fails after switching it to `ownedSubscription`.
- **STOP** if `lint:types` fails in a file outside the in-scope list because `LunoraPayment`
  grew (some hand-written object typed `LunoraPayment` that this plan did not find). Report the
  file; do not edit it.
- **STOP** if a provider adapter needs changing to make a test pass.
- **STOP** if a step's verification fails twice after a reasonable fix attempt.
- **Risk:** the hand-edited generated stub drifts from the emitter. Mitigation: insert exactly
  the text above; the reviewer's CI-equivalent check is `codegen-stub.test.ts` plus the
  `generated-files` job.

## 9. Open questions

1. Should `readonly adapter` leave `LunoraPayment` now that every money and subscription
   operation has a facade method? Removing it closes the raw path for good, but it is a wider
   break (provider-specific extras use it). Not part of this plan; owner decision.
2. Maintenance: a new subscription-mutating adapter method needs a facade twin, a
   `PAYMENT_METHODS` entry, a regenerated stub and a docs-table row. `codegen-stub.test.ts`
   and `docs.test.ts` catch the last three.
