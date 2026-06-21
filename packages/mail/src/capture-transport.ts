import type { MailTransport, SendPayload } from "./types";

/**
 * Brand marking a {@link MailTransport} as the dev capture transport. `createMailer`
 * checks it so that, in capture mode with no `queue` binding, `mailer.queue()`
 * routes through `send` (into the inbox) instead of throwing for a missing queue —
 * dev queued mail then shows up in the studio catcher just like a direct send.
 */
const CAPTURE_TRANSPORT_BRAND: unique symbol = Symbol.for("@lunora/mail.captureTransport");

/** Whether `transport` is the dev capture transport built by {@link createCaptureTransport}. */
const isCaptureTransport = (transport: MailTransport): boolean =>
    (transport as MailTransport & { [CAPTURE_TRANSPORT_BRAND]?: true })[CAPTURE_TRANSPORT_BRAND] === true;

/**
 * One captured outbound message as persisted by the dev mail catcher. Extends
 * the rendered, validated {@link SendPayload} with an `id` and a capture
 * timestamp assigned by the sink (the root-shard mailbox), so the studio inbox
 * can list and open it.
 *
 * **Canonical captured-mail wire type — single source of truth.** Every other
 * representation of a captured message mirrors this shape; consumers import it
 * directly wherever the package dependency direction allows.
 *
 * `@lunora/studio`'s `CapturedMail` re-exports this (type-only dep on
 * `@lunora/mail`). `@lunora/do`'s `CapturedMailRow` / `RecordMailInput` are
 * documented mirrors — the DO runtime stays free of any `@lunora/mail` *runtime*
 * dep — guarded by a compile-time structural assertion against this type, so a
 * field added here that isn't mirrored fails the `@lunora/do` build.
 *
 * Add or change a captured-mail field here first; the guards will point at the
 * mirrors that need the matching change.
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
 * {@link import("./types").QueueLike} — so `@lunora/mail` stays free of any
 * Durable Object / runtime dependency. The registry scaffold supplies the
 * concrete sink that POSTs to the root shard's `__lunora_admin__:recordMail` RPC.
 */
interface MailboxSink {
    record: (mail: SendPayload) => Promise<{ id: string }>;
}

/**
 * Build a capture {@link MailTransport}: instead of delivering, it persists the
 * fully rendered + validated payload to `sink` and returns the assigned id.
 *
 * Wired in dev by the mail registry scaffold so `lunora dev` shows every send in
 * the studio's Mail inbox — including `@lunora/auth`'s verification and
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
