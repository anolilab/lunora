import { cloudflareEmailProvider } from "@visulima/email/providers/cloudflare-email";

import type { ProviderSendResult } from "./provider-transport";
import { interpretSendResult, requireRecipients, toProviderEmail } from "./provider-transport";
import type { MailTransport, SendPayload } from "./types";

/**
 * Sends a raw RFC 822 message through a Worker's Email send binding. The Workers
 * runtime owns the binding, so the caller supplies this thin callback — keeping
 * `@lunora/mail` free of a `cloudflare:email` import and unit-testable. Wire it
 * in your project as:
 *
 * ```ts
 * send: async (from, to, raw) => {
 *     const { EmailMessage } = await import("cloudflare:email");
 *     await env.SEND_EMAIL.send(new EmailMessage(from, to, raw));
 * }
 * ```
 */
type CloudflareSend = (from: string, to: string, raw: string) => Promise<void>;

interface CloudflareTransportOptions {
    /** Default sender used when a `SendOptions.from` isn't supplied. */
    from: string;
    /** RFC 822 send callback bound to the Worker's `send_email` binding. */
    send: CloudflareSend;
}

/**
 * Build the default Cloudflare Email Workers transport via `@visulima/email`.
 * Cloudflare's `send_email` binding is **single-recipient** and only delivers to
 * **verified Email Routing destination addresses**, and the underlying provider
 * rejects any `cc`/`bcc` or a non-single `to` outright. So this enforces a single
 * `to` recipient (throwing a clear error instead of silently dropping the rest)
 * and rejects `cc`/`bcc` rather than forwarding them into a generic "send failed".
 * Multi-recipient transactional mail must fan out one send per recipient at the
 * call site. In dev the capture transport intercepts before this runs, so the
 * verified-address constraint never bites the dev loop.
 */
const createCloudflareTransport = (options: CloudflareTransportOptions): MailTransport => {
    const provider = cloudflareEmailProvider({ send: options.send });

    return {
        send: async (payload: SendPayload) => {
            await provider.initialize();

            // The Cloudflare provider rejects cc/bcc with a generic error; surface a
            // clear, actionable failure here instead of letting it become "send failed".
            const hasCc = Array.isArray(payload.cc) ? payload.cc.length > 0 : payload.cc !== undefined;
            const hasBcc = Array.isArray(payload.bcc) ? payload.bcc.length > 0 : payload.bcc !== undefined;

            if (hasCc || hasBcc) {
                throw new Error("@lunora/mail: Cloudflare Email Workers does not support cc/bcc — fan out one send per recipient instead");
            }

            // Single-recipient binding: reject (don't silently truncate) a multi-recipient
            // `to`. Callers must fan out one send per recipient at the call site.
            const { first, list } = requireRecipients(payload.to);

            if (list.length > 1) {
                throw new Error(
                    `@lunora/mail: Cloudflare Email Workers is single-recipient but received ${String(list.length)} \`to\` addresses — fan out one send per recipient instead`,
                );
            }

            const result = (await provider.sendEmail(toProviderEmail(payload, options.from, first))) as ProviderSendResult;

            return interpretSendResult(result);
        },
    };
};

export { createCloudflareTransport };
export type { CloudflareSend, CloudflareTransportOptions };
