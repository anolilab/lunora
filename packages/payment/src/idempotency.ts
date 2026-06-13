/**
 * Outbound idempotency keys.
 *
 * Every mutating provider call carries a stable key derived from our own operation + inputs, so
 * a Worker retry can never double-charge. Distinct from inbound webhook dedupe (keyed on the
 * provider event id).
 */

/** Build a deterministic idempotency key from an operation name and stable parts. */
const idempotencyKey = (operation: string, ...parts: ReadonlyArray<number | string>): string => [operation, ...parts.map(String)].join(":");

export default idempotencyKey;
