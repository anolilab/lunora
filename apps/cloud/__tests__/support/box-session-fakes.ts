/**
 * Fakes for driving a `BoxSessionDO` under node: a hibernatable socket that
 * records what the control plane sent, the slice of `DurableObjectState` the
 * session uses, a real Ed25519 box key, and a session subclass over a
 * {@link memoryStore}. `WebSocketPair` is workerd-only, so a test "accepts" a
 * socket by handing it to the state directly instead of upgrading.
 */
import type { CloudMessage } from "@lunora/hostd/protocol";
import { challengeSigningPayload, decodeCloudMessage, requestSigningPayload } from "@lunora/hostd/protocol";

import { toBase64Url } from "../../src/boxes/encoding";
import type { SessionAttachment } from "../../src/boxes/session";
import { openSession } from "../../src/boxes/session";
import type { BoxSessionNamespace } from "../../src/boxes/session-client";
import type { BoxSessionEnvironment, SessionSocket, SessionState } from "../../src/boxes/session-do";
import { BoxSessionDO } from "../../src/boxes/session-do";
import type { ControlPlaneStore } from "../../src/d1-store";

export interface FakeSocket extends SessionSocket {
    attachment: SessionAttachment;
    closedWith?: { code?: number; reason?: string };
    /** Every frame the control plane sent, decoded. */
    received: () => CloudMessage[];
    sent: string[];
}

export const fakeSocket = (attachment: SessionAttachment): FakeSocket => {
    const socket: FakeSocket = {
        attachment,
        close: (code, reason) => {
            socket.closedWith = { code, reason };
        },
        deserializeAttachment: () => structuredClone(socket.attachment),
        received: () =>
            socket.sent.map((frame) => {
                const decoded = decodeCloudMessage(frame);

                if (!decoded.ok) {
                    throw new Error(`the control plane sent an invalid frame: ${decoded.error.message}`);
                }

                return decoded.message;
            }),
        send: (message) => {
            socket.sent.push(message);
        },
        sent: [],
        serializeAttachment: (value) => {
            socket.attachment = structuredClone(value) as SessionAttachment;
        },
    };

    return socket;
};

export interface FakeState extends SessionState {
    alarmAt: null | number;
    sockets: FakeSocket[];
    values: Map<string, unknown>;
}

export const fakeState = (): FakeState => {
    const state: FakeState = {
        acceptWebSocket: (socket) => {
            state.sockets.push(socket as FakeSocket);
        },
        alarmAt: null,
        // A closed socket leaves the runtime's list, as it does in workerd.
        getWebSockets: () => state.sockets.filter((socket) => socket.closedWith === undefined),
        sockets: [],
        storage: {
            delete: (key) => Promise.resolve(state.values.delete(key)),
            get: <T>(key: string) => Promise.resolve(state.values.get(key) as T | undefined),
            getAlarm: () => Promise.resolve(state.alarmAt),
            list: <T>({ limit, prefix }: { limit?: number; prefix: string }) =>
                Promise.resolve(
                    new Map(
                        [...state.values]
                            .filter(([key]) => key.startsWith(prefix))
                            .slice(0, limit ?? Number.POSITIVE_INFINITY)
                            .map(([key, value]) => [key, value as T]),
                    ),
                ),
            put: (key, value) => {
                state.values.set(key, value);

                return Promise.resolve();
            },
            setAlarm: (time) => {
                state.alarmAt = time;

                return Promise.resolve();
            },
        },
        values: new Map(),
    };

    return state;
};

/** A session over an in-memory store instead of D1. */
export class TestBoxSession extends BoxSessionDO {
    private readonly store: ControlPlaneStore;

    public constructor(state: SessionState, store: ControlPlaneStore, environment: BoxSessionEnvironment = {}) {
        super(state, { DB: {}, ...environment });
        this.store = store;
    }

    protected override database(): ControlPlaneStore {
        return this.store;
    }
}

/** A box's key pair, as `hostd enrol` generates it. */
export interface BoxKey {
    privateKey: CryptoKey;
    /** Raw public key, base64url — what `boxes.publicKey` stores. */
    publicKey: string;
    sign: (payload: Uint8Array) => Promise<string>;
}

export const boxKey = async (): Promise<BoxKey> => {
    const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
    const raw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));

    return {
        privateKey: pair.privateKey,
        publicKey: toBase64Url(raw),
        sign: async (payload) => toBase64Url(new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, pair.privateKey, Uint8Array.from(payload)))),
    };
};

export const helloFrame = (boxId: string, overrides: Record<string, unknown> = {}): string =>
    JSON.stringify({
        boxId,
        fleets: [],
        protocol: 1,
        resources: { diskFreeMb: 40_960, memMb: 3891 },
        type: "hello",
        versions: { caddy: "v2.11.6", celld: "v0.6.0", hostd: "1.0.0" },
        ...overrides,
    });

export const authFrame = async (key: BoxKey, boxId: string, nonce: string): Promise<string> =>
    JSON.stringify({ signature: await key.sign(challengeSigningPayload(nonce, boxId)), type: "auth" });

/** Run the whole handshake on a fresh socket accepted by `session`. */
export const handshake = async (session: BoxSessionDO, state: FakeState, key: BoxKey, boxId: string, now = Date.now()): Promise<FakeSocket> => {
    const socket = fakeSocket(openSession(boxId, now));

    state.acceptWebSocket(socket);
    await session.webSocketMessage(socket, helloFrame(boxId));

    const challenge = socket.received().find((frame) => frame.type === "challenge");

    if (challenge?.type !== "challenge") {
        throw new Error(`no challenge: ${JSON.stringify(socket.received())}`);
    }

    await session.webSocketMessage(socket, await authFrame(key, boxId, challenge.nonce));

    return socket;
};

/** A box row as the store holds one. */
export const boxRow = (key: BoxKey, overrides: Record<string, unknown> = {}): Record<string, unknown> => {
    return {
        _id: "box_1",
        createdAt: 0,
        name: "edge",
        organizationId: "org_1",
        publicKey: key.publicKey,
        singleTrust: false,
        slug: "bslug000001",
        status: "pending",
        ...overrides,
    };
};

/** A namespace binding whose every id resolves to `session` — what `boxSession` calls through. */
export const namespaceOver = (session: BoxSessionDO): BoxSessionNamespace => {
    return {
        get: () => {
            return { fetch: (request: Request) => session.fetch(request) };
        },
        idFromName: (name) => name,
    };
};

/** Signed-request headers for `method path` from `boxId`, as `hostd` sends them (README §6.2). */
export const signedHeaders = async (
    key: BoxKey,
    input: { boxId: string; method: string; nonce: string; path: string; timestamp?: number },
): Promise<Record<string, string>> => {
    return {
        "x-lunora-box-id": input.boxId,
        "x-lunora-box-nonce": input.nonce,
        "x-lunora-box-signature": await key.sign(requestSigningPayload(input)),
        ...(input.timestamp === undefined ? {} : { "x-lunora-box-timestamp": String(input.timestamp) }),
    };
};

export type { MemoryStore } from "./memory-store";
