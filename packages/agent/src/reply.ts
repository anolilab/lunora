/**
 * The outbound half of an inbound trigger: capture where a message came from,
 * then answer in the same thread.
 *
 * Inbound is fully built (`./inbound` for email, `./channels` for
 * Slack/GitHub/Discord) and hands every mapper a verified, parsed event. What
 * this module adds is the small amount of channel knowledge needed to turn that
 * event into an {@link AgentReplyRef} and, for email, to send a correctly
 * threaded reply back.
 *
 * Only email ships a send helper. Slack, GitHub, and Discord need an OUTBOUND
 * credential (a bot token, an installation token) and the framework has no
 * store for one — `AgentInboundChannel.secret` is for verifying inbound
 * signatures, not for authenticating outbound calls. So for those channels
 * `onReply` receives `env` and the app makes the provider call with its own
 * token. Inventing a credential store to hide three fetch calls would be the
 * wrong trade.
 */
import type { Mailer } from "@lunora/mail";
import type { InboundEmail } from "@lunora/mail/inbound";

import type { AgentReplyRef } from "./types";

/** The email arm of {@link AgentReplyRef}, narrowed for the helpers below. */
type EmailReplyRef = Extract<AgentReplyRef, { channel: "email" }>;

/**
 * Capture a reply reference from an already-parsed inbound email — call it in
 * an `onEmail` mapper and put the result on the run's `replyRef`.
 *
 * Returns `undefined` when the message carries no `Message-ID`: there is
 * nothing to thread a reply against, and an unthreaded reply lands as a new
 * conversation in the recipient's client, which is worse than not replying.
 */
export const captureEmailReplyRef = (email: InboundEmail): EmailReplyRef | undefined => {
    if (email.messageId === undefined) {
        return undefined;
    }

    return {
        channel: "email",
        from: email.from,
        messageId: email.messageId,
        to: email.to,
        ...(email.references === undefined ? {} : { references: email.references }),
    };
};

/** RFC 5322 threading: append the replied-to id to any existing `References` chain. */
export const buildReferences = (replyRef: EmailReplyRef): string =>
    (replyRef.references === undefined ? replyRef.messageId : `${replyRef.references} ${replyRef.messageId}`);

/** Subject + body of a reply. */
export interface ReplyBody {
    subject: string;
    text: string;
}

/**
 * Send a threaded reply through the app's own `@lunora/mail` mailer.
 *
 * The mailer is a parameter rather than something this module constructs: the
 * app already configures one (API key or `send_email` binding), and passing it
 * in keeps this module free of any runtime dependency on `@lunora/mail`.
 *
 * The reply goes to the original sender, from the mailer's configured default.
 * An app running several aliases that wants the reply to come from whichever
 * mailbox received the message passes `from: replyRef.to[0]` itself — a
 * decision only the app can make.
 */
export const replyToEmail = async (mailer: Mailer, replyRef: EmailReplyRef, body: ReplyBody): Promise<{ id: string }> =>
    mailer.send({
        headers: { "In-Reply-To": replyRef.messageId, References: buildReferences(replyRef) },
        subject: body.subject,
        text: body.text,
        to: replyRef.from,
    });

export type { EmailReplyRef };
