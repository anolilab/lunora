import { LunoraError } from "@lunora/errors";

import type { Mailer, SendOptions } from "./types";

/** Serializable representation of a `SendOptions` payload — drops the `react` field. */
export interface QueuedSend {
    bcc?: string[];
    cc?: string[];
    from?: string;
    headers?: Record<string, string>;
    html?: string;

    /**
     * Stable dedup key, minted at enqueue time by `createMailer(...).queue()` — see
     * `SendOptions.idempotencyKey`. Carried through untouched by `consumeQueuedSend`;
     * a consumer wanting exactly-once delivery dedupes against its own store using it.
     */
    idempotencyKey?: string;
    replyTo?: string;
    subject: string;
    text?: string;
    to: string | string[];
}

/**
 * Narrow a `SendOptions` to its serializable `QueuedSend` shape by dropping the
 * non-cloneable `react` field. React elements are not structured-cloneable, so
 * the queue body must carry only the pre-rendered html/text and scalar fields.
 */
export const toQueuedPayload = (options: SendOptions): QueuedSend => {
    const queued = { ...options };

    delete queued.react;

    return queued;
};

/**
 * Helper used by Queue consumers: rehydrate a `QueuedSend` payload and forward
 * to a configured `Mailer.send()`. Use this inside your Worker's `queue()`
 * handler.
 *
 * DEDUPE IS THE CONSUMER'S JOB, and this helper does not do it. The payload's
 * `idempotencyKey` was minted once at enqueue time so it survives redelivery, but
 * nothing downstream reads it: no transport forwards it to the provider (Resend
 * dedupes on an `Idempotency-Key` REQUEST header, which the provider client offers
 * no hook for — its `headers` field becomes message headers in the body). A
 * consumer that only acks is correct for the failure the ack covers and sends a
 * duplicate for the one it does not: the provider accepted the message and the
 * worker died before acking.
 *
 * ```ts
 * export default {
 *   queue: async (batch, env) => {
 *     const mailer = createMailer({ apiKey: env.RESEND_API_KEY, from: "..." });
 *     for (const message of batch.messages) {
 *       const { idempotencyKey } = message.body;
 *       if (await env.SENT.get(idempotencyKey)) { message.ack(); continue; }
 *       await consumeQueuedSend(mailer, message.body);
 *       await env.SENT.put(idempotencyKey, "1", { expirationTtl: 86_400 });
 *       message.ack();
 *     }
 *   },
 * };
 * ```
 */
export const consumeQueuedSend = async (mailer: Mailer, payload: unknown): Promise<{ id: string }> => {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
        throw new LunoraError("INTERNAL", "@lunora/mail: queue message body must be an object");
    }

    const candidate = payload as Record<string, unknown>;

    // Shape-check the message body before handing it to the transport — the
    // queue is an untrusted boundary (workers can land arbitrary JSON) and a
    // malformed payload here would otherwise surface as an obscure provider
    // error downstream.
    if (typeof candidate.subject !== "string") {
        throw new TypeError("@lunora/mail: queue message must have a string `subject`");
    }

    const recipientIsString = typeof candidate.to === "string";
    const recipientIsStringArray = Array.isArray(candidate.to) && candidate.to.every((value) => typeof value === "string");

    if (!recipientIsString && !recipientIsStringArray) {
        throw new LunoraError("INTERNAL", "@lunora/mail: queue message `to` must be a string or string[]");
    }

    const assertOptionalString = (field: string, value: unknown): string | undefined => {
        if (value === undefined) {
            return undefined;
        }

        if (typeof value !== "string") {
            throw new TypeError(`@lunora/mail: queue message \`${field}\` must be a string`);
        }

        return value;
    };

    const assertOptionalStringList = (field: string, value: unknown): string[] | undefined => {
        if (value === undefined) {
            return undefined;
        }

        // A lone string is accepted for convenience and normalized to a
        // single-element list — `bcc`/`cc` are `string[]` downstream and the
        // address parser treats `"a"` and `["a"]` identically, so wrapping is
        // behavior-preserving while keeping the return type uniform.
        if (typeof value === "string") {
            return [value];
        }

        if (Array.isArray(value) && value.every((entry) => typeof entry === "string")) {
            return value;
        }

        throw new TypeError(`@lunora/mail: queue message \`${field}\` must be a string or string[]`);
    };

    let headers: Record<string, string> | undefined;

    if (candidate.headers !== undefined) {
        if (!candidate.headers || typeof candidate.headers !== "object" || Array.isArray(candidate.headers)) {
            throw new TypeError("@lunora/mail: queue message `headers` must be an object of string values");
        }

        const entries = Object.entries(candidate.headers as Record<string, unknown>);

        for (const [key, value] of entries) {
            if (typeof value !== "string") {
                throw new TypeError(`@lunora/mail: queue message header "${key}" must be a string`);
            }
        }

        headers = candidate.headers as Record<string, string>;
    }

    // Build a typed payload from the validated fields rather than blindly
    // casting the untrusted body — the cast would defeat the type system at
    // exactly the boundary this function exists to guard.
    const options: SendOptions = {
        bcc: assertOptionalStringList("bcc", candidate.bcc),
        cc: assertOptionalStringList("cc", candidate.cc),
        from: assertOptionalString("from", candidate.from),
        headers,
        html: assertOptionalString("html", candidate.html),
        idempotencyKey: assertOptionalString("idempotencyKey", candidate.idempotencyKey),
        replyTo: assertOptionalString("replyTo", candidate.replyTo),
        subject: candidate.subject,
        text: assertOptionalString("text", candidate.text),
        to: candidate.to as string | string[],
    };

    return mailer.send(options);
};
