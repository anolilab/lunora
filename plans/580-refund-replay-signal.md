# Plan 580 — A replayed refund tells the caller no money moved

**Baseline:** `79b0c5a6a` (2026-11-11)
**Status:** BLOCKED (needs owner: the caller-visible signal)

Finding row 41 of the 2026-11-11 audit (issue #1527). Decision plan; do not dispatch until the
owner picks an option.

## 0. Headline finding

Two intentional same-amount partial refunds of one session, without caller keys, share a derived
idempotency key. An idempotent provider replays the first refund; the facade sees the refund id's
marker already claimed and returns the session unchanged. The ledger is right, but the caller gets
the same success-shaped result as a real refund and cannot tell that the second refund never
happened.

## 1. Current state (audit)

- `packages/payment/src/create-payment.ts` lines 649-731, `refundPayment`:
    - line ~679: `outboundKey("refund_payment", [input.sessionId], input.idempotencyKey, () => [amountPart(providerAmount), input.reason ?? ""])`;
      the comment above says "Two intentional same-amount refunds need distinct caller keys".
    - lines ~701-706:

        ```ts
        // The marker for this refund id is already claimed: the provider replayed an earlier refund
        // under a colliding key, so no money moved. …
        if (!freshRefund && issuedRefund.refundId !== undefined) {
            return existing;
        }
        ```

- `packages/payment/__tests__/create-payment.test.ts` lines ~688-713 pin that the ledger is not
  inflated, not what the caller sees.
- Installed `stripe@23.0.0` exposes `lastResponse.headers`; Stripe's replay behaviour itself could
  not be verified offline.

## 2. Existing seams

`LunoraPaymentError` codes (`errors.ts`: no `REPLAYED`/`CONFLICT` code today), the observer
(`notifyObserver`), the return type `PaymentSession`.

## 3. The behavioural contract to preserve

A genuine retry of the SAME refund call (lost response) must stay safe: no second refund, no error
that makes the caller retry with a fresh key and double-refund.

## 4. Design decisions — NEEDS OWNER

- **Option 1 — observer event plus docs (recommended, smallest).** Emit `payment.refund_replayed`
  through the observer and keep returning the session; document that same-amount repeat refunds need
  caller keys. No API break; a retry stays safe. The caller still cannot tell in-band.
- **Option 2 — a typed error** (`LunoraPaymentError("CONFLICT" or new "REFUND_REPLAYED")`). Loud, but
  a lost-response retry of the same call then throws instead of succeeding, which invites callers to
  retry with a fresh key and refund twice. Adds an error code (touches `@lunora/errors` registry and
  the generated `errors.mdx`).
- **Option 3 — fold the stored refunded total into the derived key.** Makes intentional repeats
  work without caller keys, but a retry after a lost response (when the first refund already booked)
  then gets a NEW key and refunds again. Rejected unless paired with a response-loss guard.
- **Option 4 — change the return type** to `{ session, replayed: boolean }`. Precise; a breaking
  API change across docs and call sites (allowed on alpha).

Recommendation: Option 1 now; Option 4 if the owner wants an in-band signal on alpha.

## 5. Workstreams

Written as executor steps after the decision.

## 6. Platform parity

Not applicable.

## 7. Phasing & ordering

| Phase | Work           | Gate          |
| ----- | -------------- | ------------- |
| 0     | Owner decision | option chosen |

## 8. Risks & STOP conditions

- **STOP** if a chosen option makes a lost-response retry issue a second refund.

## 9. Open questions

1. Which option?
