import type { MailTransport, SendPayload } from "./types";

/**
 * Brand marking a {@link MailTransport} as the dev capture transport. `createMailer`
 * checks it so that, in capture mode with no `queue` binding, `mailer.queue()`
 * routes through `send` (into the inbox) instead of throwing for a missing queue —
 * dev queued mail then shows up in the studio catcher just like a direct send.
 */
const CAPTURE_TRANSPORT_BRAND: unique symbol = Symbol.for("@cirrus/mail.captureTransport");

/** Whether `transport` is the dev capture transport built by {@link createCaptureTransport}. */
const isCaptureTransport = (transport: MailTransport): boolean =>
    (transport as MailTransport & { [CAPTURE_TRANSPORT_BRAND]?: true })[CAPTURE_TRANSPORT_BRAND] === true;

/**
 * One captured outbound message as persisted by the dev mail catcher. Extends
 * the rendered, validated {@link SendPayload} with an `id` and a capture
 * timestamp assigned by the sink (the root-shard mailbox), so the studio inbox
 * can list and open it.
 */
interface CapturedMail extends SendPayload {
    /** Epoch-ms the message was captured. */
    capturedAt: number;
    /** Stable id assigned to the captured message. */
    id: string;
}

/**
 * Minimal projection of the persistence target the capture transport writes to
 * (the studio's root-shard mailbox). Declared structurally — like
 * {@link import("./types").QueueLike} — so `@cirrus/mail` stays free of any
 * Durable Object / runtime dependency. The registry scaffold supplies the
 * concrete sink that POSTs to the root shard's `__cirrus_admin__:recordMail` RPC.
 */
interface MailboxSink {
    record: (mail: SendPayload) => Promise<{ id: string }>;
}

/**
 * Build a capture {@link MailTransport}: instead of delivering, it persists the
 * fully rendered + validated payload to `sink` and returns the assigned id.
 *
 * Wired in dev by the mail registry scaffold so `cirrus dev` shows every send in
 * the studio's Mail inbox — including `@cirrus/auth`'s verification and
 * forgot-password mail — with no provider credentials and nothing leaving the
 * machine. Address/header validation already ran in `createMailer.buildPayload`
 * before the payload reaches here, so the captured message is the same one a
 * real transport would have sent.
 */
const createCaptureTransport = (sink: MailboxSink): MailTransport => {
    const transport: MailTransport & { [CAPTURE_TRANSPORT_BRAND]: true } = {
        [CAPTURE_TRANSPORT_BRAND]: true,
        send: async (payload: SendPayload): Promise<{ id: string }> => sink.record(payload),
    };

    return transport;
};

export { CAPTURE_TRANSPORT_BRAND, createCaptureTransport, isCaptureTransport };
export type { CapturedMail, MailboxSink };
