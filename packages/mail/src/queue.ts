import type { Mailer, SendOpts } from "./types.js";

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

export const toQueuedPayload = (opts: QueuedSend): QueuedSend => ({
    to: opts.to,
    subject: opts.subject,
    from: opts.from,
    html: opts.html,
    text: opts.text,
    cc: opts.cc,
    bcc: opts.bcc,
    replyTo: opts.replyTo,
    headers: opts.headers,
});

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
    if (!payload || typeof payload !== "object") {
        throw new Error("@cirrus/mail: queue message body must be an object");
    }

    const opts = payload as SendOpts;

    return mailer.send(opts);
};

export { type QueueLike } from "./types.js";
