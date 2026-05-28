import { resendProvider } from "@visulima/email/providers/resend";

import { toQueuedPayload } from "./queue.js";
import { renderEmail } from "./render.js";
import type { CirrusMailOptions, Mailer, MailTransport, SendOpts, SendPayload } from "./types.js";

/** `@visulima/email` models addresses as `{ email, name? }`. Accept either shape. */
const toAddress = (input: string): { email: string; name?: string } => {
    const match = /^\s*(.*?)\s*<\s*([^>]+)\s*>\s*$/.exec(input);

    if (match?.[1] && match[2]) {
        return { name: match[1], email: match[2] };
    }

    return { email: input.trim() };
};

const toAddressList = (input: string | string[] | undefined): { email: string; name?: string }[] | undefined => {
    if (input === undefined) {
        return undefined;
    }

    const list = Array.isArray(input) ? input : [input];

    return list.map(toAddress);
};

/**
 * Build the default Resend-backed transport via `@visulima/email`. Wraps the
 * provider's `sendEmail()` into the minimal `{ send(payload) -> { id } }` shape
 * the rest of `@cirrus/mail` consumes.
 */
const createResendTransport = (apiKey: string, defaultFrom: string): MailTransport => {
    const provider = resendProvider({ apiKey });

    return {
        send: async (payload: SendPayload) => {
            await provider.initialize?.();

            const toList = toAddressList(payload.to);

            if (!toList || toList.length === 0) {
                throw new Error("@cirrus/mail: at least one recipient is required");
            }

            const result = await provider.sendEmail({
                from: toAddress(payload.from ?? defaultFrom),
                to: toList.length === 1 ? toList[0]! : toList,
                subject: payload.subject,
                html: payload.html,
                text: payload.text,
                cc: toAddressList(payload.cc),
                bcc: toAddressList(payload.bcc),
                replyTo: payload.replyTo ? toAddress(payload.replyTo) : undefined,
                headers: payload.headers,
            });

            if (!result.success || !result.data) {
                const reason = result.error instanceof Error ? result.error.message : String(result.error ?? "send failed");

                throw new Error(`@cirrus/mail: send failed: ${reason}`);
            }

            return { id: result.data.messageId };
        },
    };
};

export const createMailer = (options: CirrusMailOptions): Mailer => {
    if (!options.from) {
        throw new Error("@cirrus/mail: `from` is required");
    }

    const buildDefaultTransport = (): MailTransport => {
        if (!options.apiKey) {
            throw new Error("@cirrus/mail: `apiKey` is required when no custom transport is supplied");
        }

        return createResendTransport(options.apiKey, options.from);
    };

    const transport = options.transport ?? buildDefaultTransport();

    const buildPayload = async (opts: SendOpts): Promise<SendPayload> => {
        let { html } = opts;
        let { text } = opts;

        if (opts.react) {
            const rendered = await renderEmail(opts.react);

            html = html ?? rendered.html;
            text = text ?? rendered.text;
        }

        return {
            to: opts.to,
            subject: opts.subject,
            from: opts.from ?? options.from,
            html,
            text,
            cc: opts.cc,
            bcc: opts.bcc,
            replyTo: opts.replyTo,
            headers: opts.headers,
        };
    };

    const send = async (opts: SendOpts): Promise<{ id: string }> => {
        const payload = await buildPayload(opts);

        return transport.send(payload);
    };

    const queue = async (opts: SendOpts): Promise<{ queued: true }> => {
        if (!options.queue) {
            throw new Error("@cirrus/mail: `queue` binding is required for mailer.queue()");
        }

        // React elements are NOT structured-cloneable, so the queue body
        // cannot carry the raw `react` field. We render to html/text up
        // front and serialise only the rendered output — the consumer
        // pattern intentionally works on pre-rendered payloads.
        const payload = await buildPayload(opts);

        await options.queue.send(toQueuedPayload(payload));

        return { queued: true };
    };

    return { send, queue };
};
