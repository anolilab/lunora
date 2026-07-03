import { LunoraError } from "@lunora/errors";

import { assertSafeAddresses, assertSafeHeaderValue } from "./address";
import { isCaptureTransport } from "./capture-transport";
import { createCloudflareTransport } from "./cloudflare-transport";
import { toQueuedPayload } from "./queue";
import renderEmail from "./render";
import createResendTransport from "./resend-transport";
import type { LunoraMailOptions, Mailer, MailTransport, SendOptions, SendPayload } from "./types";

/**
 * Pick the default transport when no explicit `transport` is supplied. The
 * preference order encodes "Cloudflare Email Workers is the default provider":
 * `cloudflareSend` selects the Cloudflare Email Workers transport (the
 * scaffolded default; `send_email` binding wired in the project); `apiKey`
 * selects the Resend transport (bring-your-own-provider escape hatch). Anything
 * else is a misconfiguration — fail loudly with an actionable message.
 */
const buildDefaultTransport = (options: LunoraMailOptions): MailTransport => {
    if (options.cloudflareSend) {
        return createCloudflareTransport({ from: options.from, send: options.cloudflareSend });
    }

    if (options.apiKey) {
        return createResendTransport(options.apiKey, options.from);
    }

    throw new LunoraError(
        "INTERNAL",
        "@lunora/mail: a transport is required — pass `transport`, `cloudflareSend` (Cloudflare Email Workers, the default), or `apiKey` (Resend)",
    );
};

/**
 * Create a mailer bound to a transport.
 *
 * SECURITY — recipient policy and HTML content are the caller's responsibility.
 * The mailer fully blocks header/CRLF/comma injection in addresses
 * (`assertSafeAddresses` / `assertSafeHeaderValue`), but it does NOT decide WHO
 * you may send to or WHAT HTML you render.
 *
 * Open relay: derive `to`/`cc`/`bcc` from server-trusted state, never from raw
 * request input, and prefer a fixed/allowlisted `from` — sending to an arbitrary
 * user-supplied address turns your deployment into a spam relay.
 *
 * Template XSS / content injection: treat template HTML like any other HTML sink
 * — never interpolate untrusted data into raw markup (or a
 * `dangerouslySetInnerHTML`-style template) without escaping. The mailer sends
 * whatever HTML you hand it verbatim.
 */
const createMailer = (options: LunoraMailOptions): Mailer => {
    if (!options.from) {
        throw new LunoraError("INTERNAL", "@lunora/mail: `from` is required");
    }

    const transport = options.transport ?? buildDefaultTransport(options);

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

        const from = options_.from ?? options.from;

        // Address normalization/validation lives here (not just in the transports)
        // so every transport — custom adapters and the dev capture transport
        // included — and the queue path get the same length + CR/LF/comma +
        // bracket checks.
        assertSafeAddresses({
            bcc: options_.bcc,
            cc: options_.cc,
            from,
            replyTo: options_.replyTo,
            to: options_.to,
        });

        return {
            bcc: options_.bcc,
            cc: options_.cc,
            from,
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
            // Dev capture mode has no Queue binding, so a real enqueue is
            // impossible. Rather than throw (which would break any auth/registry
            // flow that uses `queue()` in `lunora dev`), route the send straight
            // through the capture transport so the message still lands in the
            // studio inbox. Production paths always pass a real `queue` binding
            // and never hit this branch, so real-queue behavior is unchanged.
            if (isCaptureTransport(transport)) {
                const captured = await buildPayload(options_);

                await transport.send(captured);

                return { queued: true };
            }

            throw new LunoraError("INTERNAL", "@lunora/mail: `queue` binding is required for mailer.queue()");
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

export default createMailer;
