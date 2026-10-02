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
import type { BoxSession, BoxSessionNamespace } from "../../src/boxes/session-client";
import type { BoxSessionEnvironment, SessionSocket } from "../../src/boxes/session-do";
import { BoxSessionDO } from "../../src/boxes/session-do";
import type { ControlPlaneStore } from "../../src/d1-store";

const objectId = (name: string): DurableObjectId => {
    return { equals: (other) => other.name === name, name, toString: () => name };
};

export interface FakeSocket extends SessionSocket {
    attachment: SessionAttachment;
    closedWith?: { code?: number; reason?: string };
    /** Every frame the control plane sent, decoded. */
    received: () => CloudMessage[];
    sent: string[];
}

/** Called with every frame the control plane sends a socket — where a fake box answers. */
export type FrameListener = (message: string, socket: FakeSocket) => void;

export const fakeSocket = (attachment: SessionAttachment, onSend?: FrameListener): FakeSocket => {
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
            onSend?.(message, socket);
        },
        sent: [],
        serializeAttachment: (value) => {
            socket.attachment = structuredClone(value) as SessionAttachment;
        },
    };

    return socket;
};

/** The slice of `DurableObjectState` the session uses, over fake sockets and an in-memory storage map. */
export interface FakeState {
    acceptWebSocket: (socket: SessionSocket) => void;
    alarmAt: null | number;
    getWebSockets: () => SessionSocket[];
    sockets: FakeSocket[];
    storage: {
        delete: (key: string) => Promise<unknown>;
        get: <T>(key: string) => Promise<T | undefined>;
        getAlarm: () => Promise<null | number>;
        list: <T>(options: { limit?: number; prefix: string }) => Promise<Map<string, T>>;
        put: (key: string, value: unknown) => Promise<void>;
        setAlarm: (time: number) => Promise<void>;
    };
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

    public constructor(state: FakeState, store: ControlPlaneStore, environment: BoxSessionEnvironment = {}) {
        // The fake is the slice of the runtime's state the session reads.
        super(state as unknown as DurableObjectState, { DB: {}, ...environment });
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
export const handshake = async (
    session: BoxSessionDO,
    state: FakeState,
    key: BoxKey,
    boxId: string,
    options: { now?: number; onSend?: FrameListener } = {},
): Promise<FakeSocket> => {
    const socket = fakeSocket(openSession(boxId, options.now ?? Date.now()), options.onSend);

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

/** A namespace binding whose every id resolves to `session` — what `boxSession` calls through, here without RPC in between. */
export const namespaceOver = (session: BoxSessionDO): BoxSessionNamespace => {
    return { get: () => session, idFromName: objectId };
};

/** A namespace binding over hand-written sessions, by box id: the methods a test cares about, every other one refusing. */
export const fakeSessionNamespace = (session: (boxId: string) => Partial<BoxSession>): BoxSessionNamespace => {
    const unused = (): Promise<never> => Promise.reject(new Error("not used by this test"));

    return {
        get: (id) => {
            return { claimNonce: unused, close: unused, dispatch: unused, fetch: unused, pushRoutes: unused, ...session(id.name ?? "") };
        },
        idFromName: objectId,
    };
};

/** Signed-request headers for `method path` from `boxId`, as `hostd` sends them (README §6.2). */
export const signedHeaders = async (
    key: BoxKey,
    input: { boxId: string; method: string; nonce: string; path: string; timestamp: number },
): Promise<Record<string, string>> => {
    return {
        "x-lunora-box-id": input.boxId,
        "x-lunora-box-nonce": input.nonce,
        "x-lunora-box-signature": await key.sign(requestSigningPayload(input)),
        "x-lunora-box-timestamp": String(input.timestamp),
    };
};

export type { MemoryStore } from "./memory-store";

/**
 * A stand-in for `lunora-hostd` on the far end of an authenticated socket, as a
 * {@link FrameListener}: it runs each `job` frame the control plane sends
 * against `fleets` (alias → deployment), streams one progress line, and answers
 * a `result` — through the session's own `webSocketMessage`, exactly as frames
 * from a real box arrive.
 */
export const fakeHostd =
    (session: BoxSessionDO, fleets: Map<string, string>): FrameListener =>
    (message, socket) => {
        const decoded = decodeCloudMessage(message);

        if (!decoded.ok || decoded.message.type !== "job") {
            return;
        }

        const { job, jobId } = decoded.message;

        if (job.kind === "deploy") {
            fleets.set(job.alias, job.deploymentId);
        } else if (job.kind === "destroy") {
            fleets.delete(job.alias);
        }

        const answer = async (): Promise<void> => {
            await session.webSocketMessage(socket, JSON.stringify({ jobId, line: `${job.kind}: done`, type: "progress" }));
            await session.webSocketMessage(socket, JSON.stringify({ jobId, ok: true, type: "result" }));
        };

        setTimeout(() => {
            answer().catch(() => undefined);
        }, 0);
    };
