# Plan 579 — A second identical checkout gets a fresh session when Stripe replays a finished one

**Baseline:** `4121b67cc` (2026-11-12; `packages/payment` is unchanged since `79b0c5a6a`)
**Status:** DONE (APPROVED; PR #1571, branch fix/improve-579-checkout-replay)

> **Executor instructions**: Follow this plan step by step. Run every verification command and
> confirm the expected result before moving on. If anything in "STOP conditions" (section 8)
> occurs, stop and report; do not improvise. Do not edit `plans/README.md`.
>
> **Drift check (run first)**:
> `git diff --stat 4121b67cc..HEAD -- packages/payment/src/providers/stripe.ts packages/payment/__tests__/providers/stripe.test.ts packages/payment/docs/index.mdx`
> Empty output expected; otherwise compare section 1 with the live code and STOP on a mismatch.

Finding row 40 of the 2026-11-11 audit (issue #1527).

## 0. Headline finding

The facade derives the checkout idempotency key purely from the request (reference, price, mode,
quantity, URLs, metadata, expiry). A customer who completes or abandons a checkout and starts an
identical one inside Stripe's idempotency window sends the same key, and Stripe replays the first
response: the same Checkout Session, already `complete` or `expired`, whose URL cannot be paid.

## 1. Current state (audit)

- `packages/payment/src/create-payment.ts` lines 326-337, `startCheckout`: the derived key
  `outboundKey("checkout", [input.referenceId], input.idempotencyKey, () => [priceId, mode, quantity, successUrl, cancelUrl, metadata, expiresAt?])`,
  then `adapter.createCheckout({ ...input, customerId, idempotencyKey: key, metadata })`. Not changed
  by this plan.
- `packages/payment/src/providers/stripe.ts` lines 461-484, `createCheckout`:

    ```ts
    const session = await client.checkout.sessions.create(
        { cancel_url: input.cancelUrl, /* … */ success_url: input.successUrl },
        { idempotencyKey: input.idempotencyKey },
    );

    return { id: session.id, provider: "stripe", url: session.url ?? "" };
    ```

- Installed `stripe@23.0.0`, `esm/resources/Checkout/Sessions.d.ts` lines 287-289: a Session has
  `status: Session.Status | null` — "one of `open`, `complete`, or `expired`". Responses also expose
  `lastResponse.headers` (`esm/lib.d.ts` lines 161-171).
- **Not verifiable offline:** Stripe's server-side replay (documented by Stripe as returning the
  same status and body for a reused key within at least 24 hours) and the `Idempotent-Replayed`
  header. The adapter therefore keys on the session's own `status`, which the SDK types guarantee,
  not on the header.
- Other adapters: only Stripe sends the derived checkout key as a provider idempotency key. Polar
  (`providers/polar.ts` `checkouts.create`) and Dodo (`providers/dodopayments.ts` `checkoutSessions.create`)
  send none; Creem passes it as `requestId`, which the installed `creem@1.13.0` documents only as
  "Identify and track each checkout request", not as an idempotency key. So only the Stripe adapter
  changes.
- Tests: `packages/payment/__tests__/providers/stripe.test.ts` — the client double's
  `checkout.sessions.create` (lines 43-48) records `[parameters, options]` and returns
  `{ id: "cs_1", url: "https://checkout.test" }` (no `status`); line 147-158 asserts the forwarded key.
- Docs: `packages/payment/docs/index.mdx` lines 298-312 describe the checkout idempotency key.

## 2. Existing seams

`LunoraPaymentError("PROVIDER_ERROR", message)` (copy the order used elsewhere in `stripe.ts`), the
client double in `stripe.test.ts`.

## 3. The behavioural contract to preserve

- An `open` session (or one with no `status`, as the existing doubles return) is returned exactly as
  today, from one call: a double-click still yields one session.
- Every existing Stripe test passes unchanged.

## 4. Design decisions

**Owner decision (2026-11-12):** retry once with a derived fresh key when the replayed session is no
longer `open`. No clock in the key.

- After `create`, when `session.status` is `"complete"` or `"expired"`, call `create` once more with
  the same parameters and the key `${input.idempotencyKey}:${session.id}`. `startCheckout` always hands the adapter a key
  (`create-payment.ts:395` derives one from the request when the caller gave none), so a keyless
  caller replays too; only a direct adapter call with no key skips the retry. The suffix is
  deterministic, so a double-click after the first session finished still collapses onto one new
  session.
- If the second response is also not `open`, throw `PROVIDER_ERROR`:
  `stripe replayed a finished checkout session for this request twice; pass a distinct idempotencyKey to start a new one`.
- A why-comment says that the key is derived from the request, so a repeat purchase inside Stripe's
  idempotency window gets the earlier finished session back, and that the status (typed by the
  SDK) is used because the replay header could not be relied on.
- Docs: add two sentences to the idempotency paragraph in `packages/payment/docs/index.mdx` saying a
  Stripe replay of a completed or expired session is retried once under a derived key, so a repeat
  checkout gets a payable session.
- **Rejected (owner):** a time bucket in the key; a required caller nonce.

## 5. Workstreams

One workstream, size S. One commit, type `fix`, scope `payment`.

### Commands you will need

| Purpose         | Command (worktree root)                                                              | Expected |
| --------------- | ------------------------------------------------------------------------------------ | -------- |
| Install         | `pnpm install --frozen-lockfile`                                                     | exit 0   |
| Build deps once | `pnpm --filter "@lunora/payment..." run build`                                       | exit 0   |
| Test file       | `pnpm --filter "@lunora/payment" exec vitest run __tests__/providers/stripe.test.ts` | all pass |
| Package tests   | `pnpm --filter "@lunora/payment" run test`                                           | all pass |
| Format code     | `pnpm exec oxfmt <file>` per changed .ts file                                        | exit 0   |
| Format docs     | `pnpm exec prettier --write packages/payment/docs/index.mdx`                         | exit 0   |
| ESLint          | `pnpm --filter "@lunora/payment" run lint:eslint`                                    | exit 0   |
| Types           | `pnpm --filter "@lunora/payment" run lint:types`                                     | exit 0   |

### Scope

**In scope:** `packages/payment/src/providers/stripe.ts`,
`packages/payment/__tests__/providers/stripe.test.ts`, `packages/payment/docs/index.mdx` (the
checkout idempotency paragraph only).

**Out of scope:** `create-payment.ts`, the other adapters, `types.ts`, `plans/README.md`.

### Git workflow

- Branch `fix/improve-579-checkout-replay`, from `origin/alpha`. Do not push.
- One commit: `fix(payment): retry a Stripe checkout that replays a finished session`; body ≤ 4
  lines (≤ 100 chars each); last line `Co-Authored-By: Claude Haiku 5.5 <noreply@anthropic.com>`.
- Stage explicit paths. Never `git add -A`, `git commit -a`, any `git stash`, `--no-verify`.

### Executor rules

- Work only inside your worktree. Never run `pnpm run test:workerd`, `build:packages`, `build`,
  repo-root `test`, or `pnpm -r`. oxfmt before ESLint; Prettier for `.mdx`. No `.js` import
  extensions. Named exports only. Comments say why and assert no third-party behaviour beyond
  section 1. No `.skip`, `@ts-expect-error`, `as any`, or new `eslint-disable` without rule +
  `-- reason`. Cognitive-complexity limit 15: extract a helper rather than disable.

### Step 1: Install and build — **Verify:** exit 0.

### Step 2: Write the failing tests

In `stripe.test.ts`, beside the checkout key test (line ~147), using a client double whose
`checkout.sessions.create` returns a queued sequence of sessions and records `[parameters, options]`:

1. First response `{ id: "cs_old", status: "complete", url: … }`, second `{ id: "cs_new", status: "open", url: "https://checkout.test/new" }`:
   the result is `cs_new`, `create` was called twice, the second call's `idempotencyKey` is
   `"<first key>:cs_old"`, and both calls sent identical parameters.
2. Same with `status: "expired"` first.
3. First response `status: "open"`: one call only, result is that session.
4. Two non-open responses in a row: rejects with `LunoraPaymentError` code `"PROVIDER_ERROR"`, two
   calls made.
5. The adapter called directly with no `idempotencyKey` and a `complete` response: one call, no
   retry (Stripe had no key to replay against).

**Verify:** test-file command → cases 1, 2 and 4 FAIL.

### Step 3: Implement — per section 4. **Verify:** test-file command passes.

### Step 4: Docs — per section 4. **Verify:** `pnpm exec prettier --check packages/payment/docs/index.mdx` exits 0.

### Step 5: Gates, then commit — **Verify:** formatters, ESLint, types, package tests exit 0. Commit. `git status --short` empty.

### Step 6: Prove the tests need the fix (after the commit; no stash)

```bash
git show 4121b67cc:packages/payment/src/providers/stripe.ts > packages/payment/src/providers/stripe.ts
pnpm --filter "@lunora/payment" exec vitest run __tests__/providers/stripe.test.ts   # cases 1, 2, 4 FAIL
git checkout HEAD -- packages/payment/src/providers/stripe.ts
git status --short   # empty
```

## 6. Platform parity

Not applicable.

## 7. Phasing & ordering

| Phase | Work      | Gate                                                       |
| ----- | --------- | ---------------------------------------------------------- |
| 0     | Steps 1-6 | new cases red on base, green with fix; payment gates green |

## 8. Risks & STOP conditions

- **STOP** if section 1 does not match the live code.
- **STOP** if `lint:types` says `status` is not on the `create` result (installed SDK differs).
- **Risk:** one extra Stripe call, only when a finished session is replayed.

## 9. Open questions

1. None.

## Done criteria

- [ ] `pnpm --filter "@lunora/payment" run test`, `lint:eslint`, `lint:types` exit 0.
- [ ] Cases 1, 2, 4 fail against `4121b67cc`'s `stripe.ts`.
- [ ] `git diff --stat origin/alpha..HEAD` lists only the three in-scope files.
