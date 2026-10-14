/**
 * The body of a copy `dispatchQueueBatch` re-enqueues when a dispatch is
 * declined on a message's last delivery: the replaced message's id and body,
 * authenticated with an HMAC (see `@lunora/dispatch`'s `signRequeue`).
 *
 * The consumer derives a message's replay-dedup ids from its id, so a body that
 * could claim an id would choose which cached results its calls get. Only an
 * envelope carrying a valid MAC is unwrapped; anything else under the reserved
 * key is delivered as the plain body it is, under the broker's own id. And
 * `ctx.queues` refuses to send the reserved key at all ({@link hasRequeueKey}).
 *
 * The body travels as the JSON text of its wire encoding (`shared/wire-codec`),
 * so the MAC covers exact bytes, a `bigint`/`Date`/bytes body survives, and a
 * dead-lettered copy stays readable JSON.
 */
// eslint-disable-next-line import/no-extraneous-dependencies -- @lunora/dispatch is a devDependency on purpose: packem inlines it into this bundle, so it is not a published runtime dep
import { signRequeue, verifyRequeue } from "@lunora/dispatch";

import { decodeWire, encodeWire } from "../../../shared/wire-codec";

/** The reserved body key a re-enqueued copy carries. */
const REQUEUED_KEY = "$lunora.requeued$";

/** Separates this package's MACs from the scheduler's. */
const SCOPE = "queue";

/** Cloudflare Queues' per-message limit. */
const MAX_MESSAGE_BYTES = 128 * 1024;

/** True when `body` carries the reserved key — refused on `ctx.queues` sends. */
const hasRequeueKey = (body: unknown): boolean => typeof body === "object" && body !== null && Object.hasOwn(body, REQUEUED_KEY);

/**
 * The copy's body. Throws when the body has no wire encoding (a class
 * instance, a cycle) or the copy would exceed the message limit — the caller
 * then keeps the delayed retry and logs why.
 */
const sealRequeue = async (secret: string, id: string, body: unknown): Promise<Record<string, unknown>> => {
    const payload = JSON.stringify(encodeWire(body));
    const envelope = { [REQUEUED_KEY]: { body: payload, id, mac: await signRequeue(secret, SCOPE, id, payload) } };
    const size = new TextEncoder().encode(JSON.stringify(envelope)).byteLength;

    if (size > MAX_MESSAGE_BYTES) {
        throw new RangeError(`the copy would be ${String(size)} bytes, over the ${String(MAX_MESSAGE_BYTES)}-byte queue message limit`);
    }

    return envelope;
};

/**
 * The id and body a copy stands for, or `undefined` for any body that is not a
 * genuine copy: no reserved key, a malformed envelope, no `secret` to check
 * with, or a MAC that does not verify.
 */
const openRequeue = async (secret: string | undefined, body: unknown): Promise<{ body: unknown; id: string } | undefined> => {
    if (secret === undefined || !hasRequeueKey(body)) {
        return undefined;
    }

    const envelope = (body as Record<string, unknown>)[REQUEUED_KEY] as { body?: unknown; id?: unknown; mac?: unknown } | null | undefined;

    if (typeof envelope?.id !== "string" || typeof envelope.body !== "string") {
        return undefined;
    }

    if (!(await verifyRequeue(secret, SCOPE, envelope.id, envelope.body, envelope.mac))) {
        return undefined;
    }

    return { body: decodeWire(JSON.parse(envelope.body)), id: envelope.id };
};

export { hasRequeueKey, openRequeue, REQUEUED_KEY, sealRequeue };
