import { resendProvider } from "@visulima/email/providers/resend";

import type { ProviderSendResult } from "./provider-transport";
import { interpretSendResult, requireRecipients, toProviderEmail } from "./provider-transport";
import type { MailTransport, SendPayload } from "./types";

/**
 * Build a Resend-backed transport via `@visulima/email`. Wraps the provider's
 * `sendEmail()` into the minimal `{ send(payload) -> { id } }` shape the rest of
 * `@cirrus/mail` consumes. Kept reachable as a named export so a project that
 * prefers Resend over the Cloudflare default can pass
 * `transport: createResendTransport(apiKey, from)` to `createMailer`.
 */
const createResendTransport = (apiKey: string, defaultFrom: string): MailTransport => {
    const provider = resendProvider({ apiKey });

    return {
        send: async (payload: SendPayload) => {
            await provider.initialize();

            const { first, list } = requireRecipients(payload.to);
            // Resend accepts a single address or a list; collapse a 1-element list.
            const result = (await provider.sendEmail(toProviderEmail(payload, defaultFrom, list.length === 1 ? first : list))) as ProviderSendResult;

            return interpretSendResult(result);
        },
    };
};

export default createResendTransport;
