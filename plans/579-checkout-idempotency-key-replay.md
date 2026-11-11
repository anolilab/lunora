# Plan 579 — A second identical checkout gets a new session instead of a replayed one

**Baseline:** `79b0c5a6a` (2026-11-11)
**Status:** BLOCKED (needs owner: idempotency key design)

Finding row 40 of the 2026-11-11 audit (issue #1527). Decision plan; do not dispatch until the
owner picks an option.

## 0. Headline finding

The facade derives the checkout idempotency key purely from the request (reference, price, mode,
quantity, URLs, metadata, expiry). A customer who completes or abandons a checkout and starts an
identical one within the provider's idempotency window sends the same key, and an idempotent
provider replays the FIRST response: the same session, possibly already completed or expired.

## 1. Current state (audit)

- `packages/payment/src/create-payment.ts` lines 300-338, `startCheckout`:

    ```ts
    // Every request-shaping field is part of the key, so a changed checkout is a new request
    // rather than a replay (or a provider-side mismatch) of the earlier one.
    const key = await outboundKey("checkout", [input.referenceId], input.idempotencyKey, () => [
        input.priceId,
        input.mode,
        String(input.quantity ?? 1),
        input.successUrl,
        input.cancelUrl ?? "",
        metadata ? JSON.stringify(metadata) : "",
        ...(input.expiresAt === undefined ? [] : [String(input.expiresAt)]),
    ]);

    return adapter.createCheckout({ ...input, customerId: customer?.id, idempotencyKey: key, metadata });
    ```

- `packages/payment/src/providers/stripe.ts` ~line 480 passes it as Stripe's `idempotencyKey`.
- `packages/payment/__tests__/create-payment.test.ts` lines ~164-172 pin that two identical calls
  produce the same key.
- Installed `stripe@23.0.0`: `RequestOptions.idempotencyKey` is sent as the `Idempotency-Key`
  header; every response exposes `lastResponse.headers` (`esm/lib.d.ts` lines 161-171), so an
  `idempotent-replayed` header is readable. Stripe's server-side replay window (documented as at
  least 24 hours, same status and body) could NOT be verified offline.

## 2. Existing seams

`outboundKey`, `CheckoutRequest.idempotencyKey` (a caller key already overrides the derived one),
`lastResponse.headers` on Stripe responses.

## 3. The behavioural contract to preserve

A double-click (two identical calls within seconds) still yields ONE session. A caller-supplied
`idempotencyKey` keeps its exact meaning.

## 4. Design decisions — NEEDS OWNER

- **Option 1 — detect a stale replay in the Stripe adapter (recommended).** After `create`, if the
  session `status` is not `"open"` (completed or expired), retry once with a derived key suffixed by
  the replayed session id. Deterministic, so a double-click after completion still collapses; no
  clock. Stripe-only; other adapters keep today's behaviour until shown to replay.
- **Option 2 — time bucket in the derived key** (e.g. 10 minutes). Simple and provider-neutral, but
  a double-click straddling a bucket boundary creates two sessions, and it reads the clock.
- **Option 3 — require a caller nonce** for checkout (no derived key). Correct but moves the burden
  to every app and breaks today's double-click protection for callers who omit it.

Recommendation: Option 1, plus a facade docs note that a caller key is the way to scope sessions
explicitly.

## 5. Workstreams

Written as executor steps after the decision. Scope then: `providers/stripe.ts`,
`__tests__/providers/stripe.test.ts`, docs `packages/payment/docs/index.mdx` (one paragraph).

## 6. Platform parity

Not applicable.

## 7. Phasing & ordering

| Phase | Work           | Gate                                                                                        |
| ----- | -------------- | ------------------------------------------------------------------------------------------- |
| 0     | Owner decision | option chosen                                                                               |
| 1     | Implementation | test: replayed completed session → second create with a new key; double-click → one session |

## 8. Risks & STOP conditions

- **Risk:** Option 1 adds one extra Stripe call only on a stale replay.
- **STOP** if Stripe's replay behaviour is found to differ from its docs; re-plan.

## 9. Open questions

1. Which option?
2. Do Polar, Dodo or Creem replay on their idempotency keys at all? Not checked.
