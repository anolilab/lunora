/**
 * The two ends of one Node WebSocket connection.
 *
 * Cloudflare's `WebSocketPair` gives the shard a server end to accept and hands
 * the 101 response a client end. A Node process has neither, so this module
 * builds the pair. The server end is what the shard accepts. Its frames reach
 * the network once a `ws` socket is attached to the client end. Until then they
 * queue, bounded, because a route's `onOpen` can send before the handshake is
 * complete.
 *
 * The client end travels to the HTTP listener inside a marker `Response`. A
 * Node `Response` cannot carry status 101, so the marker is a 200 with a one-time
 * token header, which survives a worker rebuilding the response. The listener
 * looks the token up and replaces the marker with the real handshake.
 */

import { LunoraError } from "@lunora/errors";
import type { WebSocket } from "ws";

import { toArrayBuffer } from "./to-array-buffer";

/** Frames a shard may queue on one connection before its handshake completes. Past this the connection is closed. */
const MAX_QUEUED_FRAMES = 256;

/**
 * The client's keepalive and its reply. The Cloudflare runtime answers these itself through
 * `setWebSocketAutoResponse`; Node has no such hook, so the pair answers them here. Same strings as
 * `@lunora/do`'s `WS_KEEPALIVE_PING` / `WS_KEEPALIVE_PONG`.
 */
const KEEPALIVE_PING = "lunora-ping";
const KEEPALIVE_PONG = "lunora-pong";

/** The inbound events a socket host forwards to the shard that owns the connection. */
interface NodeSocketHub {
    close: (socket: NodeServerEnd, code: number, reason: string, wasClean: boolean) => void;
    message: (socket: NodeServerEnd, data: string | ArrayBuffer) => void;
}

/** The end a shard accepts. Its `send` and `close` are what the socket host calls through its handle. */
interface NodeServerEnd {
    close: (code?: number, reason?: string) => void;
    send: (data: string | ArrayBuffer) => void;
}

/** The end the upgrade response carries. Only the HTTP listener attaches to it. */
class NodeClientEnd {
    readonly #abandon: () => void;
    readonly #attach: (ws: WebSocket) => void;

    public constructor(attach: (ws: WebSocket) => void, abandon: () => void) {
        this.#attach = attach;
        this.#abandon = abandon;
    }

    /** Wire a completed `ws` handshake to the server end: outbound frames flow to `ws`, inbound frames and the close go to the hub. */
    public attach(ws: WebSocket): void {
        this.#attach(ws);
    }

    /**
     * End a pair whose handshake will not complete (the request was refused or the client went away
     * first). The shard accepted the server end, so it is told the socket closed. Idempotent.
     */
    public abandon(): void {
        this.#abandon();
    }
}

/** Build a connected pair whose inbound frames and close are delivered to `hub`. */
const createNodeSocketPair = (hub: NodeSocketHub): { client: NodeClientEnd; server: NodeServerEnd } => {
    let network: undefined | { close: (code?: number, reason?: string) => void; send: (data: string | ArrayBuffer) => void };
    // Once the server end is closed nothing more is sent. The shard is still told the close exactly once, below.
    let closed = false;
    let notified = false;
    const queued: (string | ArrayBuffer)[] = [];

    // Exactly one close reaches the shard, whichever side closed first.
    const notifyClosed = (socket: NodeServerEnd, code: number, reason: string, wasClean: boolean): void => {
        if (notified) {
            return;
        }

        notified = true;
        hub.close(socket, code, reason, wasClean);
    };

    const server: NodeServerEnd = {
        close: (code, reason) => {
            if (closed) {
                return;
            }

            closed = true;

            if (network === undefined) {
                notifyClosed(server, code ?? 1000, reason ?? "", true);
            } else {
                // The transport's own 'close' event notifies the shard.
                network.close(code, reason);
            }
        },
        send: (data) => {
            if (closed) {
                return;
            }

            if (network !== undefined) {
                network.send(data);

                return;
            }

            if (queued.length >= MAX_QUEUED_FRAMES) {
                // A handshake that stalls this long is not coming. The shard is told the socket is gone.
                closed = true;
                notifyClosed(server, 1011, "handshake stalled", false);

                return;
            }

            queued.push(data);
        },
    };

    const client = new NodeClientEnd(
        (ws) => {
            if (closed) {
                // The shard closed the connection before the handshake finished, so the client is turned away.
                ws.close(1001, "connection closed before the handshake completed");

                return;
            }

            if (network !== undefined) {
                throw new LunoraError("INTERNAL", "a Node socket pair attaches to exactly one live transport");
            }

            network = {
                close: (code, reason) => {
                    ws.close(code, reason);
                },
                send: (data) => {
                    ws.send(data);
                },
            };

            for (const frame of queued.splice(0)) {
                ws.send(frame);
            }

            ws.on("message", (data: Buffer | ArrayBuffer | Buffer[], isBinary: boolean) => {
                // `ws` reassembles fragments before emitting, so an array never reaches here with the default binary type.
                if (closed || Array.isArray(data)) {
                    return;
                }

                const text = isBinary ? undefined : new TextDecoder().decode(data);

                if (text === KEEPALIVE_PING) {
                    ws.send(KEEPALIVE_PONG);

                    return;
                }

                hub.message(server, text ?? toArrayBuffer(data));
            });

            // `ws` emits 'error' before 'close'; the close is what the shard hears, so the error itself has nothing to add.
            ws.on("error", () => undefined);

            ws.on("close", (code: number, reason: Buffer) => {
                closed = true;
                notifyClosed(server, code, reason.toString("utf8"), code === 1000 || code === 1005);
            });
        },
        () => {
            if (network === undefined) {
                closed = true;
                notifyClosed(server, 1006, "handshake did not complete", false);
            }
        },
    );

    return { client, server };
};

/** The header a marker carries its token in. A worker that rebuilds the response keeps its headers, not its identity. */
const UPGRADE_TOKEN_HEADER = "x-lunora-node-upgrade";

/** How long a marker waits for the HTTP listener. One it never sees, because the worker failed after the shard accepted, is dropped then. */
const UPGRADE_TOKEN_TTL_MS = 30_000;

/** Marker tokens, each mapped to the client end it carries until the HTTP listener takes it. */
const upgrades = new Map<string, NodeClientEnd>();

/** The marker `Response` a shard returns for an accepted upgrade. */
const upgradeMarkerFor = (client: NodeClientEnd): Response => {
    const token = crypto.randomUUID();

    upgrades.set(token, client);

    // ponytail: one timer per pending handshake, which is fine at handshake rates. An unclaimed marker's pair is
    // abandoned, so the shard hears the socket close instead of keeping it registered.
    setTimeout(() => {
        if (upgrades.delete(token)) {
            client.abandon();
        }
    }, UPGRADE_TOKEN_TTL_MS).unref();

    // eslint-disable-next-line unicorn/no-null -- a marker: its body is never read
    return new Response(null, { headers: { [UPGRADE_TOKEN_HEADER]: token }, status: 200 });
};

/** The client end a marker response carries, or `undefined` for any other response. A token is taken once. */
const takeUpgradeClient = (response: Response): NodeClientEnd | undefined => {
    const token = response.headers.get(UPGRADE_TOKEN_HEADER);

    if (token === null) {
        return undefined;
    }

    const client = upgrades.get(token);

    upgrades.delete(token);

    return client;
};

export type { NodeServerEnd, NodeSocketHub };
export { createNodeSocketPair, NodeClientEnd, takeUpgradeClient, upgradeMarkerFor };
