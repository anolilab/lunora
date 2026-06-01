import type { Mailer, SendOpts as SendOptions } from "./types.js";

/** Serializable representation of a `SendOpts` payload — drops the `react` field. */
export interface QueuedSend {
    bcc?: string[];
    cc?: string[];
    from?: string;
    headers?: Record<string, string>;
    html?: string;
    replyTo?: string;
    subject: string;
    text?: string;
    to: string | string[];
}

export const toQueuedPayload = (options: QueuedSend): QueuedSend => {
    return {
        bcc: options.bcc,
        cc: options.cc,
        from: options.from,
        headers: options.headers,
        html: options.html,
        replyTo: options.replyTo,
        subject: options.subject,
        text: options.text,
        to: options.to,
    };
};

/**
 * Helper used by Queue consumers: rehydrate a `QueuedSend` payload and forward
 * to a configured `Mailer.send()`. Use this inside your Worker's `queue()`
 * handler.
 *
 * ```ts
 * export default {
 *   queue: async (batch, env) => {
 *     const mailer = createMailer({ apiKey: env.RESEND_API_KEY, from: "..." });
 *     for (const message of batch.messages) {
 *       await consumeQueuedSend(mailer, message.body);
 *     }
 *   },
 * };
 * ```
 */
export const consumeQueuedSend = async (mailer: Mailer, payload: unknown): Promise<{ id: string }> => {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
        throw new Error("@cirrus/mail: queue message body must be an object");
    }

    const candidate = payload as Record<string, unknown>;

    // Shape-check the message body before handing it to the transport — the
    // queue is an untrusted boundary (workers can land arbitrary JSON) and a
    // malformed payload here would otherwise surface as an obscure provider
    // error downstream.
    if (typeof candidate.subject !== "string") {
        throw new TypeError("@cirrus/mail: queue message must have a string `subject`");
    }

    const recipientIsString = typeof candidate.to === "string";
    const recipientIsStringArray = Array.isArray(candidate.to) && candidate.to.every((value) => typeof value === "string");

    if (!recipientIsString && !recipientIsStringArray) {
        throw new Error("@cirrus/mail: queue message `to` must be a string or string[]");
    }

    return mailer.send(candidate as unknown as SendOptions);
};

export { type QueueLike } from "./types.js";
