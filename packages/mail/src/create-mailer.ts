import { resendProvider } from "@visulima/email/providers/resend";

import { toQueuedPayload } from "./queue.js";
import { renderEmail } from "./render.js";
import type { CirrusMailOptions, Mailer, MailTransport, SendOpts as SendOptions, SendPayload } from "./types.js";

/** RFC 5321 caps the entire mailbox path at 320 chars; reject anything longer. */
const MAX_EMAIL_LENGTH = 320;
const MAX_NAME_LENGTH = 256;

const ADDRESS_PATTERN = /^\s*(.*?)\s*<\s*([^>]+)\s*>\s*$/;

/**
 * Reject CR/LF (the classic SMTP header-injection vector — splits the header
 * into attacker-controlled extra headers) and commas (separate the address in
 * SMTP `To:`/`Cc:` lists, so a single field with a `,` smuggles a second
 * recipient past `to:` validation).
 */
const assertSafeAddressField = (field: "email" | "name", value: string): void => {
    if (value.includes("\r") || value.includes("\n") || value.includes(",")) {
        throw new Error(`@cirrus/mail: address ${field} must not contain CR, LF, or comma`);
    }
};

/**
 * Reject CR/LF in a free-form header value (subject, custom header keys/values).
 * Same header-injection vector as the address fields, but commas are legal here
 * so only the line terminators are forbidden — a smuggled CR/LF would split the
 * value into attacker-controlled extra headers.
 */
const assertSafeHeaderValue = (label: string, value: string): void => {
    if (value.includes("\r") || value.includes("\n")) {
        throw new Error(`@cirrus/mail: ${label} must not contain CR or LF`);
    }
};

/** `@visulima/email` models addresses as `{ email, name? }`. Accept either shape. */
const toAddress = (input: string): { email: string; name?: string } => {
    const match = ADDRESS_PATTERN.exec(input);

    if (match?.[1] && match[2]) {
        const name = match[1];
        const email = match[2];

        if (name.length > MAX_NAME_LENGTH) {
            throw new Error(`@cirrus/mail: address name must be <= ${String(MAX_NAME_LENGTH)} characters`);
        }

        if (email.length > MAX_EMAIL_LENGTH) {
            throw new Error(`@cirrus/mail: address email must be <= ${String(MAX_EMAIL_LENGTH)} characters`);
        }

        assertSafeAddressField("name", name);
        assertSafeAddressField("email", email);

        return { email, name };
    }

    const email = input.trim();

    if (email.length > MAX_EMAIL_LENGTH) {
        throw new Error(`@cirrus/mail: address email must be <= ${String(MAX_EMAIL_LENGTH)} characters`);
    }

    assertSafeAddressField("email", email);

    return { email };
};

const toAddressList = (input: string | string[] | undefined): { email: string; name?: string }[] | undefined => {
    if (input === undefined) {
        return undefined;
    }

    const list = Array.isArray(input) ? input : [input];

    return list.map((entry) => toAddress(entry));
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
            const [firstRecipient] = toList ?? [];

            if (!toList || firstRecipient === undefined) {
                throw new Error("@cirrus/mail: at least one recipient is required");
            }

            const result = await provider.sendEmail({
                bcc: toAddressList(payload.bcc),
                cc: toAddressList(payload.cc),
                from: toAddress(payload.from ?? defaultFrom),
                headers: payload.headers,
                html: payload.html,
                replyTo: payload.replyTo ? toAddress(payload.replyTo) : undefined,
                subject: payload.subject,
                text: payload.text,
                to: toList.length === 1 ? firstRecipient : toList,
            });

            if (!result.success || !result.data) {
                const rawError: unknown = result.error;
                let reason: string;

                if (rawError instanceof Error) {
                    reason = rawError.message;
                } else if (rawError === null || rawError === undefined) {
                    reason = "send failed";
                } else if (typeof rawError === "string") {
                    reason = rawError;
                } else if (typeof rawError === "number" || typeof rawError === "boolean" || typeof rawError === "bigint") {
                    reason = rawError.toString();
                } else {
                    // object | symbol | function — stringify defensively
                    reason = JSON.stringify(rawError) ?? "send failed";
                }

                // Keep the raw provider detail in server logs only — surfacing
                // it to callers can disclose provider internals. Throw a stable,
                // generic message.
                console.error(`@cirrus/mail: send failed: ${reason}`);

                throw new Error("@cirrus/mail: send failed");
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

    const buildPayload = async (options_: SendOptions): Promise<SendPayload> => {
        let { html } = options_;
        let { text } = options_;

        if (options_.react) {
            const rendered = await renderEmail(options_.react);

            html = html ?? rendered.html;
            text = text ?? rendered.text;
        }

        // The subject and any custom headers flow straight into the provider's
        // header block, so they need the same CR/LF rejection the address
        // fields get. Validated here so both send() and queue() are covered.
        assertSafeHeaderValue("subject", options_.subject);

        if (options_.headers) {
            for (const [name, value] of Object.entries(options_.headers)) {
                assertSafeHeaderValue(`header name "${name}"`, name);
                assertSafeHeaderValue(`header "${name}" value`, value);
            }
        }

        return {
            bcc: options_.bcc,
            cc: options_.cc,
            from: options_.from ?? options.from,
            headers: options_.headers,
            html,
            replyTo: options_.replyTo,
            subject: options_.subject,
            text,
            to: options_.to,
        };
    };

    const send = async (options_: SendOptions): Promise<{ id: string }> => {
        const payload = await buildPayload(options_);

        return transport.send(payload);
    };

    const queue = async (options_: SendOptions): Promise<{ queued: true }> => {
        if (!options.queue) {
            throw new Error("@cirrus/mail: `queue` binding is required for mailer.queue()");
        }

        // React elements are NOT structured-cloneable, so the queue body
        // cannot carry the raw `react` field. We render to html/text up
        // front and serialise only the rendered output — the consumer
        // pattern intentionally works on pre-rendered payloads.
        const payload = await buildPayload(options_);

        await options.queue.send(toQueuedPayload(payload));

        return { queued: true };
    };

    return { queue, send };
};
