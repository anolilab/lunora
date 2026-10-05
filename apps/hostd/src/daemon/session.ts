/**
 * The box's control session (plan 458 D1, W4; protocol §2): one outbound
 * WebSocket to `GET /v1/boxes/connect?box={id}` on the enrolled control plane.
 *
 * The box sends `hello`, answers the server's `challenge` with `auth` (an
 * Ed25519 signature over the nonce), then takes `routes`, `config` and `job`
 * frames and answers `ping`. Every inbound frame is strictly decoded; one that does not
 * decode ends the connection, which is then retried. A lost connection is
 * retried with jittered exponential backoff from one second to a minute, reset
 * once a session authenticates. The control plane's refusals steer it:
 * `BOX_REVOKED` stops the session for good (the daemon exits non-zero and the
 * machine must be enrolled again), while `SUPERSEDED` — another session of
 * this box authenticated — and every other refusal back off before the next
 * attempt.
 *
 * The WebSocket is Node's global one (Node ≥ 22); tests inject their own.
 */
import { decodeCloudMessage, encodeMessage } from "../wire/codec";
import { challengeSigningPayload } from "../wire/signing";
import type { BoxMessage, ConfigMessage, HelloMessage, JobMessage, RouteEntry } from "../wire/types";
import type { BoxIdentity } from "./identity";
import type { Logger } from "./log";

/** Backoff between connection attempts: 1 s doubling to 60 s, jittered. */
const RECONNECT_BACKOFF = { maxMs: 60_000, minMs: 1000 } as const;

/** After this long without any frame (the server pings every 30 s), the connection is presumed dead. */
const SILENCE_TIMEOUT_MS = 120_000;

/**
 * The box's own send budget. The control plane refuses a socket that sends
 * more than four frames a second sustained (240 burst); the box stays well
 * under it: a burst of 100, then three a second, queued in order.
 */
const SEND_BUDGET = { capacity: 100, refillPerSecond: 3 } as const;

/** Frames queued behind the send budget before the oldest progress lines are dropped. */
const MAX_OUTBOX = 2000;

/** What the session reads off a WebSocket event: `data` of a message, `code` and `reason` of a close. */
interface SocketEvent {
    code?: number;
    data?: unknown;
    reason?: string;
}

/** The minimal WebSocket surface the session uses — the WHATWG one. */
interface SessionSocket {
    addEventListener: (type: "close" | "error" | "message" | "open", listener: (event: SocketEvent) => void) => void;
    close: (code?: number, reason?: string) => void;
    readonly readyState: number;
    send: (data: string) => void;
}

type SocketFactory = (url: string) => SessionSocket;

/** Why the session ended for good. */
type SessionEnd = { code: "BOX_REVOKED"; message: string } | { code: "STOPPED" };

interface SessionOptions {
    boxId: string;
    controlPlane: string;
    /** The `hello` to send on each connect — read fresh, so it reports the fleets as they are now. */
    hello: () => HelloMessage;
    identity: BoxIdentity;
    logger: Logger;
    /** The control plane's runtime configuration for the box (log forwarding), on every `config`. */
    onConfig?: (message: ConfigMessage) => void;
    onJob: (message: JobMessage) => void;
    /** Called once a connection authenticates (e.g. to drain queued reports). */
    onReady?: () => void;
    onRoutes: (table: RouteEntry[]) => void;
    /** `Math.random`, injected for tests. */
    random?: () => number;
    socket?: SocketFactory;
}

const OPEN = 1;

/** The delay before attempt number `attempt` (0-based): `min(60 s, 1 s · 2^attempt)`, jittered to between half and all of it, never under a second. */
const reconnectDelay = (attempt: number, random: () => number): number => {
    const ceiling = Math.min(RECONNECT_BACKOFF.maxMs, RECONNECT_BACKOFF.minMs * 2 ** Math.min(attempt, 16));

    return Math.max(RECONNECT_BACKOFF.minMs, Math.round(ceiling / 2 + random() * (ceiling / 2)));
};

/** `ws(s)://{control plane}/v1/boxes/connect?box={id}`. */
const connectUrlOf = (controlPlane: string, boxId: string): string => {
    const url = new URL("/v1/boxes/connect", controlPlane);

    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.searchParams.set("box", boxId);

    return url.toString();
};

type Frame = ArrayBuffer | ArrayBufferView | string;

const isFrame = (data: unknown): data is Frame => typeof data === "string" || data instanceof ArrayBuffer || ArrayBuffer.isView(data);

/** A frame's payload as a WebSocket delivered it: text, or bytes holding UTF-8 text; anything else decodes as nothing. */
const frameOf = (data: unknown): Frame => (isFrame(data) ? data : "");

/** A refusal code in a close reason (`BOX_REVOKED`), for a peer that missed the `error` frame. */
const REFUSAL_CODE_PATTERN = /^[A-Z][A-Z\d_]+$/u;

class Session {
    private socket: SessionSocket | undefined;

    private attempt = 0;

    private authenticated = false;

    private authSent = false;

    private readonly outbox: BoxMessage[] = [];

    private pumpTimer: ReturnType<typeof setTimeout> | undefined;

    private refilledAt = Date.now();

    private tokens: number = SEND_BUDGET.capacity;

    private refusal: { code: string; message: string } | undefined;

    private reconnectTimer: ReturnType<typeof setTimeout> | undefined;

    private silenceTimer: ReturnType<typeof setTimeout> | undefined;

    private stopped = false;

    private finish: ((end: SessionEnd) => void) | undefined;

    private readonly options: SessionOptions;

    public constructor(options: SessionOptions) {
        this.options = options;
    }

    /** Whether the session is authenticated and can carry frames now. */
    public get ready(): boolean {
        return this.authenticated && this.socket?.readyState === OPEN;
    }

    /** Connect, and keep reconnecting until {@link stop} or a revocation. Resolves with why it ended. */
    public async run(): Promise<SessionEnd> {
        const ended = new Promise<SessionEnd>((resolve) => {
            this.finish = resolve;
        });

        this.connect();

        return ended;
    }

    /** Send a frame. `false` when the session is not authenticated, so the caller can keep it for later. */
    public send(message: BoxMessage): boolean {
        if (!this.ready) {
            return false;
        }

        this.outbox.push(message);

        if (this.outbox.length > MAX_OUTBOX) {
            // Shed progress, never a result or a report.
            const index = this.outbox.findIndex((queued) => queued.type === "progress");

            this.outbox.splice(index === -1 ? 0 : index, 1);
        }

        this.pump();

        return true;
    }

    /** Close the connection and stop reconnecting. */
    public stop(): void {
        this.stopped = true;
        this.clearTimers();
        this.socket?.close(1000, "lunora-hostd stopping");
        this.end({ code: "STOPPED" });
    }

    /** Send queued frames while the budget allows; schedule the rest. */
    private pump(): void {
        const now = Date.now();

        this.tokens = Math.min(SEND_BUDGET.capacity, this.tokens + ((now - this.refilledAt) / 1000) * SEND_BUDGET.refillPerSecond);
        this.refilledAt = now;

        while (this.outbox.length > 0 && this.tokens >= 1 && this.socket?.readyState === OPEN) {
            const message = this.outbox.shift() as BoxMessage;

            this.tokens -= 1;

            try {
                this.socket.send(encodeMessage(message));
            } catch {
                // The close handler clears the outbox.
            }
        }

        if (this.outbox.length > 0 && this.pumpTimer === undefined) {
            this.pumpTimer = setTimeout(
                () => {
                    this.pumpTimer = undefined;
                    this.pump();
                },
                Math.ceil(1000 / SEND_BUDGET.refillPerSecond),
            );
        }
    }

    private end(end: SessionEnd): void {
        this.finish?.(end);
        this.finish = undefined;
    }

    private clearTimers(): void {
        if (this.reconnectTimer !== undefined) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = undefined;
        }

        if (this.silenceTimer !== undefined) {
            clearTimeout(this.silenceTimer);
            this.silenceTimer = undefined;
        }

        if (this.pumpTimer !== undefined) {
            clearTimeout(this.pumpTimer);
            this.pumpTimer = undefined;
        }

        // Frames for a socket that is gone: the control plane failed their jobs already.
        this.outbox.length = 0;
    }

    private armSilence(socket: SessionSocket): void {
        if (this.silenceTimer !== undefined) {
            clearTimeout(this.silenceTimer);
        }

        this.silenceTimer = setTimeout(() => {
            this.options.logger.warn("no frame from the control plane for 120 s; reconnecting");
            socket.close(4000, "silent");
        }, SILENCE_TIMEOUT_MS);
    }

    private connect(): void {
        if (this.stopped) {
            return;
        }

        const factory = this.options.socket ?? ((url: string) => new WebSocket(url));
        const socket = factory(connectUrlOf(this.options.controlPlane, this.options.boxId));

        this.socket = socket;
        this.authenticated = false;
        this.authSent = false;
        this.refusal = undefined;

        socket.addEventListener("open", () => {
            this.armSilence(socket);
            socket.send(encodeMessage(this.options.hello()));
        });
        socket.addEventListener("message", (event) => {
            this.armSilence(socket);
            this.onFrame(socket, frameOf(event.data));
        });
        socket.addEventListener("error", () => {
            // The close that follows decides what happens next.
        });
        socket.addEventListener("close", (event) => {
            this.onClose(socket, event.code ?? 1006, event.reason ?? "");
        });
    }

    private onFrame(socket: SessionSocket, frame: ArrayBuffer | ArrayBufferView | string): void {
        const decoded = decodeCloudMessage(frame);

        if (!decoded.ok) {
            this.options.logger.warn(`the control plane sent a frame this box does not accept (${decoded.error.code}: ${decoded.error.message}); reconnecting`);
            socket.close(4002, "bad frame");

            return;
        }

        const { message } = decoded;

        if (message.type === "challenge") {
            socket.send(encodeMessage({ signature: this.options.identity.sign(challengeSigningPayload(message.nonce, this.options.boxId)), type: "auth" }));
            this.authSent = true;

            return;
        }

        if (message.type === "error") {
            // The control plane closes right after; the close decides.
            this.refusal = { code: message.code, message: message.message };

            return;
        }

        // The control plane sends nothing else before it verified `auth` (protocol §2.2).
        if (!this.authSent) {
            this.options.logger.warn(`the control plane sent ${message.type} before the handshake; reconnecting`);
            socket.close(4003, "out of order");

            return;
        }

        this.markAuthenticated();

        switch (message.type) {
            case "config": {
                this.options.onConfig?.(message);
                break;
            }
            case "job": {
                this.options.onJob(message);
                break;
            }
            case "ping": {
                socket.send(encodeMessage({ type: "pong" }));
                break;
            }
            case "routes": {
                this.options.onRoutes(message.table);
                break;
            }
            default: {
                // Exhaustive: a new frame type fails to compile here until it is handled.
                const unhandled: never = message;

                this.options.logger.warn(`the control plane sent a ${(unhandled as { type: string }).type} frame this box does not handle`);
            }
        }
    }

    private markAuthenticated(): void {
        if (this.authenticated) {
            return;
        }

        this.authenticated = true;
        this.attempt = 0;
        this.options.logger.info("connected to the control plane");
        this.options.onReady?.();
    }

    private onClose(socket: SessionSocket, code: number, reason: string): void {
        if (socket !== this.socket) {
            return;
        }

        this.authenticated = false;
        this.clearTimers();

        if (this.stopped) {
            return;
        }

        // The refusal frame says why; the close reason carries the same code for a peer that missed it.
        const refusal = this.refusal ?? (REFUSAL_CODE_PATTERN.test(reason) ? { code: reason, message: reason } : undefined);

        if (refusal?.code === "BOX_REVOKED") {
            this.options.logger.error(`this box was revoked by the control plane: ${refusal.message}`);
            this.stopped = true;
            this.end({ code: "BOX_REVOKED", message: refusal.message });

            return;
        }

        const delay = reconnectDelay(this.attempt, this.options.random ?? Math.random);

        this.attempt += 1;
        this.options.logger.warn(
            `${refusal === undefined ? `connection closed (${String(code)})` : `refused: ${refusal.code}: ${refusal.message}`}; reconnecting in ${String(Math.round(delay / 1000))} s`,
        );
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = undefined;
            this.connect();
        }, delay);
    }
}

export type { SessionEnd, SessionOptions, SessionSocket, SocketFactory };
export { connectUrlOf, RECONNECT_BACKOFF, reconnectDelay, SEND_BUDGET, Session, SILENCE_TIMEOUT_MS };
