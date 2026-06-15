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
 * **verified Email Routing destination addresses**, so this picks the first
 * recipient as the envelope `to` (cc/bcc still ride along in the rendered
 * message). In dev the capture transport intercepts before this runs, so the
 * verified-address constraint never bites the dev loop.
 */
const createCloudflareTransport = (options: CloudflareTransportOptions): MailTransport => {
    const provider = cloudflareEmailProvider({ send: options.send });

    return {
        send: async (payload: SendPayload) => {
            await provider.initialize();

            // Single-recipient binding: deliver to the first address. Multi-recipient
            // transactional mail should fan out one send per recipient at the call site.
            const { first } = requireRecipients(payload.to);
            const result = (await provider.sendEmail(toProviderEmail(payload, options.from, first))) as ProviderSendResult;

            return interpretSendResult(result);
        },
    };
};

export { createCloudflareTransport };
export type { CloudflareSend, CloudflareTransportOptions };
