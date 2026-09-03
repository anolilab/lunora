/**
 * Outbound idempotency keys.
 *
 * Almost every mutating provider call carries a stable key derived from our own operation + inputs,
 * so a Worker retry can never double-charge. Distinct from inbound webhook dedupe (keyed on the
 * provider event id).
 *
 * THE ONE EXCEPTION IS A POLAR REFUND. `@polar-sh/sdk`'s `RefundCreate` has no idempotency field
 * and the endpoint accepts none, so a retried `refunds.create` genuinely issues a second refund —
 * nothing on the wire can prevent it. The guard for that call is local instead: `refundPayment`
 * records the refunded total on the session row before returning, so the over-refund check rejects
 * the retry without reaching the adapter. Polar's *usage* ingestion does dedupe, on `externalId`.
 */
import type { Money } from "./types";

const encoder = new TextEncoder();

const sha256Hex = async (value: string): Promise<string> =>
    [...new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value)))].map((byte) => byte.toString(16).padStart(2, "0")).join("");

/**
 * Build a deterministic idempotency key from an operation name and stable parts.
 * @experimental
 */
export const idempotencyKey = (operation: string, ...parts: ReadonlyArray<number | string>): string => [operation, ...parts.map(String)].join(":");

/**
 * Build a fixed-length idempotency key by hashing the request-shaping parts. Use this when the parts
 * can be long or arbitrary (checkout URLs + JSON metadata): Stripe rejects idempotency keys longer
 * than 255 characters, and two full redirect URLs plus metadata routinely exceed that. Hashing a
 * JSON-encoded parts array also removes the collision hazard of joining unescaped values with `:`
 * (distinct inputs can otherwise produce the same key within the provider's idempotency window).
 */
export const derivedIdempotencyKey = async (operation: string, provider: string, ...parts: ReadonlyArray<number | string>): Promise<string> => {
    const digest = await sha256Hex(JSON.stringify([provider, ...parts.map(String)]));

    return `${operation}:${provider}:${digest}`;
};

/**
 * Marker recording that the facade already folded ONE specific refund into `sessionId`'s row.
 *
 * Claimed (in the same store as inbound event ids) by `refundPayment` and consumed by the provider's
 * confirming `payment.refunded` webhook, so a DELTA provider's event — Polar, Creem, Dodo, which
 * report one refund each rather than a running total — does not add the same money a second time.
 * Absolute providers (Stripe) are idempotent without it, and an unconsumed marker is inert.
 *
 * The key is the provider's own `refundId` whenever there is one, because that is the only per-refund
 * identity: two in-flight refunds of the same amount on one session are two distinct refunds, and
 * keying on the amount would give them one shared marker, so one confirming event would be counted
 * twice. `amount` is the fallback for a provider that reports no refund id, and carries that
 * collision.
 */
export const localRefundKey = (sessionId: string, refundId: string | undefined, amount: Money): string =>
    refundId === undefined ? `local-refund:${sessionId}:${amount.currency}:${String(amount.minorUnits)}` : `local-refund:${sessionId}:id:${refundId}`;

/**
 * Claim `type` recorded for a {@link localRefundKey} marker. Internal bookkeeping, not a provider
 * delivery — the `marker.` prefix is what separates the two in the `events` audit log.
 */
export const LOCAL_REFUND_CLAIM_TYPE = "marker.local_refund";
