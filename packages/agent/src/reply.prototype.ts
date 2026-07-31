/**
 * DESIGN-SPIKE PROTOTYPE — see `plans/242-agent-reply-design.md`.
 *
 * NOT wired into `component.ts`, `agent-loop.ts`, `inbound.ts`, `channels.ts`,
 * or `types.ts`, and NOT exported from `./index`. This proves out the
 * capture -> run -> threaded-reply round trip for the ONE channel (email)
 * this spike prototypes; production wiring (if this direction is ratified)
 * belongs in `types.ts` (`AgentReplyRef`, `AgentEmailRun.replyRef`) and
 * `agent-loop.ts` (an `onReply` hook on the terminal turn), not here.
 *
 * Deliberately reuses the REAL `@lunora/mail` `Mailer` contract rather than
 * a hand-rolled stand-in, so the prototype exercises the package's actual
 * address/header validation — a fake mail transport only replaces the final
 * network hop.
 * @experimental
 */
import type { Mailer } from "@lunora/mail";
import type { InboundEmail } from "@lunora/mail/inbound";

/**
 * The email variant of the design doc's `AgentReplyRef` union — captured at
 * `onEmail` mapper time from fields `@lunora/mail/inbound`'s
 * `parseInboundEmail` already produced, not re-parsed from anything raw.
 */
interface EmailReplyRef {
    channel: "email";
    /** Who to reply TO — the original sender. */
    from: string;
    /** Becomes the reply's `In-Reply-To` header. */
    messageId: string;
    /** The inbound message's own `References` chain, if any — appended to, not replaced. */
    references?: string;
    /** Who the reply comes FROM — the original recipient(s) (mailbox that received it). */
    to: string[];
}

/**
 * Capture a reply reference from an already-parsed inbound email. Returns
 * `undefined` when the message carries no `Message-ID` — there is nothing to
 * thread a reply against, so (mirroring plan 240's honest-reject-over-
 * silent-misbehavior stance) the caller should decline to reply rather than
 * send an unthreaded one.
 */
const captureEmailReplyRef = (email: InboundEmail): EmailReplyRef | undefined => {
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
const buildReferences = (replyRef: EmailReplyRef): string => {
    if (replyRef.references === undefined) {
        return replyRef.messageId;
    }

    return `${replyRef.references} ${replyRef.messageId}`;
};

interface ReplyBody {
    subject: string;
    text: string;
}

/**
 * Send a threaded reply for a captured email ref through a REAL `Mailer`.
 * Standing in for what an `onReply` hook (design doc, not implemented here)
 * would call once a run's final answer is ready.
 *
 * `replyRef.to` (the mailbox the inbound message was addressed to) is
 * captured but unused here — this minimal prototype always sends from the
 * mailer's configured default `from`. A multi-alias app that wants the reply
 * to come from the SAME address that received it would pass `from:
 * replyRef.to[0]` explicitly; that's a real-wiring decision, not a spike one.
 */
const replyToEmail = async (mailer: Mailer, replyRef: EmailReplyRef, body: ReplyBody): Promise<{ id: string }> =>
    mailer.send({
        headers: { "In-Reply-To": replyRef.messageId, References: buildReferences(replyRef) },
        subject: body.subject,
        text: body.text,
        to: replyRef.from,
    });

export { buildReferences, captureEmailReplyRef, replyToEmail };
export type { EmailReplyRef, ReplyBody };
