/**
 * Outbound idempotency keys.
 *
 * Every mutating provider call carries a stable key derived from our own operation + inputs, so
 * a Worker retry can never double-charge. Distinct from inbound webhook dedupe (keyed on the
 * provider event id).
 */

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
