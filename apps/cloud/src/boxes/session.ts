/**
 * The box side of a `BoxSessionDO` socket, as pure state transitions
 * (plan 458 G11, `protocol/hostd/README.md` §2).
 *
 * Every frame a box sends is untrusted input (plan 458 §8): it is size-capped
 * and strictly decoded by `@lunora/hostd/protocol`, rate-limited per socket,
 * and only accepted in the phase the protocol allows it. The handshake is:
 *
 * 1. the box sends `hello` — its protocol version is negotiated BEFORE the rest
 *    is validated (a newer box must get `PROTOCOL_UNSUPPORTED`, not a decode
 *    error), and its `boxId` must be the box this socket was opened for;
 * 2. the control plane answers one `challenge` with a fresh single-use nonce;
 * 3. the box answers `auth`, an Ed25519 signature over
 *    `challengeSigningPayload(nonce, boxId)`, verified with WebCrypto against
 *    the box's enrolled public key.
 *
 * Anything else — a wrong signature, a revoked or unknown box, a frame out of
 * order, a malformed frame, a flood — ends in one `error` frame and a close.
 *
 * The state lives in the socket's attachment ({@link SessionAttachment}), so it
 * survives the Durable Object hibernating between frames. The attachment holds
 * only small, bounded fields — workerd caps a serialized attachment at 16 KiB,
 * and a `hello` may list 500 fleets — so the fleets travel as an effect instead
 * ({@link SessionEffect} `hello`), and the session keeps them in memory until
 * the box authenticates.
 */
import type { BoxResources, BoxVersions, FleetSummary, HostdFrame, ProgressMessage, ReportMessage, ResultMessage } from "@lunora/hostd/protocol";
import { challengeSigningPayload, decodeBoxMessage, negotiateProtocolVersion, peekProtocolVersion } from "@lunora/hostd/protocol";

import { randomBase64Url, verifyBoxSignature } from "./encoding";

/** Where a socket is in the handshake. */
export type SessionPhase = "awaiting-auth" | "awaiting-hello" | "ready";

/** Per-socket state, serialised onto the WebSocket so it survives hibernation. Small by design. */
export interface SessionAttachment {
    /** The box this socket was opened for (`/v1/boxes/connect?box=`). */
    boxId: string;
    /** Frames left in the rate-limit bucket, and when it was last refilled. */
    bucket: { refilledAt: number; tokens: number };
    /** Set once the control plane refused the socket; it counts for nothing until the runtime drops it. */
    closed?: boolean;
    /** What `hello` reported that fits an attachment, kept until `auth` succeeds and it is recorded. */
    hello?: { resources: BoxResources; versions: BoxVersions };
    /** The outstanding challenge nonce. Cleared once used — a nonce answers exactly one `auth`. */
    nonce?: string;
    /** When the socket was accepted — bounds how long the handshake may take. */
    openedAt: number;
    phase: SessionPhase;
    /** When the box last sent anything — the liveness clock. */
    seenAt: number;
}

/** A box as the session checks it against — the identity half of its `boxes` row. */
export interface SessionBox {
    publicKey: string;
    revoked: boolean;
}

/** What the session needs from outside: the box's identity, and fresh nonces. */
export interface SessionPorts {
    loadBox: (boxId: string) => Promise<null | SessionBox>;
    /** A fresh challenge nonce; ≥ 22 base64url characters (128 bits). Injected for tests. */
    nonce?: () => string;
}

/** What a frame made the session do, in order. The Durable Object carries these out. */
export type SessionEffect =
    | { close: true; code: string; message: string }
    /** The box proved its key; `nonce` is the challenge it answered — the key its `hello` fleets were held under. */
    | { hello: NonNullable<SessionAttachment["hello"]>; kind: "authenticated"; nonce: string }
    /** A `hello` was challenged with `nonce`: hold its fleets until that challenge is answered (never written before). */
    | { fleets: FleetSummary[]; kind: "hello"; nonce: string }
    | { kind: "pong" }
    | { kind: "progress"; message: ProgressMessage }
    | { kind: "report"; message: ReportMessage }
    | { kind: "result"; message: ResultMessage }
    | { kind: "send"; message: { nonce: string; type: "challenge" } };

/** Frames a socket may send in a burst, and per second after it. Generous for a well-behaved box, fatal for a flood. */
export const FRAME_BUCKET = { capacity: 240, refillPerSecond: 4 } as const;

/** How long a socket may take from upgrade to a verified `auth`. */
export const HANDSHAKE_TIMEOUT_MS = 30_000;

/** A box that has sent nothing for this long is offline (plan 458 W2). */
export const SILENCE_LIMIT_MS = 90_000;

/** What a revoked box is told. */
export const REVOKED_MESSAGE = "this box has been revoked; enrol the machine again to use it";

/** A fresh attachment for a socket just accepted for `boxId`. */
export const openSession = (boxId: string, now: number): SessionAttachment => {
    return { boxId, bucket: { refilledAt: now, tokens: FRAME_BUCKET.capacity }, openedAt: now, phase: "awaiting-hello", seenAt: now };
};

/** The socket's next state, and what to do about the frame. */
export interface FrameOutcome {
    attachment: SessionAttachment;
    effects: SessionEffect[];
}

const refuse = (attachment: SessionAttachment, code: string, message: string): FrameOutcome => {
    return { attachment, effects: [{ close: true, code, message }] };
};

/** Refill the socket's bucket to `now` and take one frame from it; `undefined` when it is empty. */
const takeToken = (bucket: SessionAttachment["bucket"], now: number): SessionAttachment["bucket"] | undefined => {
    const elapsedSeconds = Math.max(0, now - bucket.refilledAt) / 1000;
    const tokens = Math.min(FRAME_BUCKET.capacity, bucket.tokens + elapsedSeconds * FRAME_BUCKET.refillPerSecond);

    return tokens >= 1 ? { refilledAt: now, tokens: tokens - 1 } : undefined;
};

/** The first frame: negotiate, decode, check the box, then challenge it. */
const onHello = async (attachment: SessionAttachment, frame: HostdFrame, ports: SessionPorts): Promise<FrameOutcome> => {
    // The version is read BEFORE strict validation (README §3): a newer hello may
    // carry fields this version rejects, and its operator must be told to upgrade.
    const offered = peekProtocolVersion(frame);
    const negotiated = offered === undefined ? undefined : negotiateProtocolVersion(offered);

    if (negotiated?.ok === false) {
        return refuse(attachment, negotiated.code, negotiated.message);
    }

    const decoded = decodeBoxMessage(frame);

    if (!decoded.ok || decoded.message.type !== "hello") {
        return refuse(attachment, "BAD_MESSAGE", decoded.ok ? "the first frame must be hello" : `invalid hello: ${decoded.error.message}`);
    }

    const hello = decoded.message;

    // An unknown box and a box id that is not this socket's are the same failure,
    // so a caller cannot probe which box ids exist.
    const box = hello.boxId === attachment.boxId ? await ports.loadBox(attachment.boxId) : null;

    if (box === null) {
        return refuse(attachment, "AUTH_FAILED", "unknown box");
    }

    if (box.revoked) {
        return refuse(attachment, "BOX_REVOKED", REVOKED_MESSAGE);
    }

    const nonce = (ports.nonce ?? randomBase64Url)();

    return {
        attachment: { ...attachment, hello: { resources: hello.resources, versions: hello.versions }, nonce, phase: "awaiting-auth" },
        effects: [
            { fleets: hello.fleets, kind: "hello", nonce },
            { kind: "send", message: { nonce, type: "challenge" } },
        ],
    };
};

/** The second frame: the signature over the challenge. */
const onAuth = async (current: SessionAttachment, frame: HostdFrame, ports: SessionPorts): Promise<FrameOutcome> => {
    const { hello, nonce, ...rest } = current;
    // The nonce is single use, whatever happens next.
    const attachment: SessionAttachment = { ...rest, ...(hello === undefined ? {} : { hello }) };
    const decoded = decodeBoxMessage(frame);

    if (!decoded.ok || decoded.message.type !== "auth" || nonce === undefined) {
        return refuse(attachment, "BAD_MESSAGE", decoded.ok ? "expected auth after challenge" : `invalid auth: ${decoded.error.message}`);
    }

    // Re-read rather than trusting the hello-time read: a revoke can land between the two frames.
    const box = await ports.loadBox(attachment.boxId);

    if (box === null) {
        return refuse(attachment, "AUTH_FAILED", "unknown box");
    }

    if (box.revoked) {
        return refuse(attachment, "BOX_REVOKED", REVOKED_MESSAGE);
    }

    if (!(await verifyBoxSignature(box.publicKey, decoded.message.signature, challengeSigningPayload(nonce, attachment.boxId)))) {
        return refuse(attachment, "AUTH_FAILED", "the challenge signature does not verify against this box's key");
    }

    return { attachment: { ...rest, phase: "ready" }, effects: hello === undefined ? [] : [{ hello, kind: "authenticated", nonce }] };
};

/** A frame from an authenticated box. `hello` and `auth` are no longer valid. */
const onReady = (attachment: SessionAttachment, frame: HostdFrame): FrameOutcome => {
    const decoded = decodeBoxMessage(frame);

    if (!decoded.ok) {
        return refuse(attachment, "BAD_MESSAGE", `invalid frame: ${decoded.error.message}`);
    }

    const { message } = decoded;

    switch (message.type) {
        case "pong": {
            return { attachment, effects: [{ kind: "pong" }] };
        }
        case "progress": {
            return { attachment, effects: [{ kind: "progress", message }] };
        }
        case "report": {
            return { attachment, effects: [{ kind: "report", message }] };
        }
        case "result": {
            return { attachment, effects: [{ kind: "result", message }] };
        }
        default: {
            return refuse(attachment, "BAD_MESSAGE", `${message.type} is only valid during the handshake`);
        }
    }
};

/**
 * Apply one frame from the box: the socket's next state (the caller
 * re-serialises it) and the effects to carry out. Never throws on box input.
 */
export const receiveFrame = async (current: SessionAttachment, frame: HostdFrame, now: number, ports: SessionPorts): Promise<FrameOutcome> => {
    const bucket = takeToken(current.bucket, now);
    const attachment: SessionAttachment = { ...current, bucket: bucket ?? { refilledAt: now, tokens: 0 }, seenAt: now };

    if (bucket === undefined) {
        return refuse(attachment, "RATE_LIMITED", `more than ${String(FRAME_BUCKET.refillPerSecond)} frames per second sustained`);
    }

    switch (attachment.phase) {
        case "awaiting-auth": {
            return onAuth(attachment, frame, ports);
        }
        case "awaiting-hello": {
            return onHello(attachment, frame, ports);
        }
        default: {
            return onReady(attachment, frame);
        }
    }
};

/** What the liveness check decides for one socket. */
export type LivenessVerdict = "close-handshake" | "close-silent" | "ping" | "wait";

/**
 * The liveness check for one socket at `now`: a handshake that took too long is
 * closed, an authenticated box silent for {@link SILENCE_LIMIT_MS} is closed
 * (and goes offline), and everything else is pinged.
 */
export const livenessOf = (attachment: SessionAttachment, now: number): LivenessVerdict => {
    if (attachment.phase !== "ready") {
        return now - attachment.openedAt > HANDSHAKE_TIMEOUT_MS ? "close-handshake" : "wait";
    }

    return now - attachment.seenAt > SILENCE_LIMIT_MS ? "close-silent" : "ping";
};
