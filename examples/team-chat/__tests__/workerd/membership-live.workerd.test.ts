/**
 * Channel membership over a live subscription, against the app's real Worker and a real `ShardDO`.
 *
 * The node suite re-runs every subscription on each mutation, so it cannot show what a shard pushes. Here each
 * caller is an actual better-auth session, the socket is the production `/_lunora/ws` upgrade on the channel's
 * shard, and every write is an RPC to that shard. Each wait resolves on a frame the server sent, never on a timer.
 */
import { createMigrationAuth, ensureMigrated } from "@lunora/auth/migrate";
import { env, SELF } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";

import { authOptions } from "../../lunora/auth";

const ORIGIN = "https://team-chat.test";

interface Frame {
    [key: string]: unknown;
    id?: string;
    type: string;
}

interface Waiter {
    matches: (frame: Frame) => boolean;
    resolve: (frame: Frame) => void;
}

/** The unique name a test uses for its channel, so each test's shard starts empty. */
const channelFor = (label: string): string => `${label}-${crypto.randomUUID()}`;

/**
 * Creates the better-auth tables in the test D1, as the deploy-time migration does. The app's Worker does not run
 * the sweep on its first request, so sign-up would find no `user` table without this.
 */
const migrateSignIn = async (): Promise<void> => {
    await ensureMigrated(createMigrationAuth({ ...authOptions({ AUTH_SECRET: env.AUTH_SECRET }), database: env.DB as never }));
};

/** Signs up a fresh account through the app's own better-auth route and returns the session cookie. */
const signUp = async (label: string): Promise<string> => {
    const name = `${label}-${crypto.randomUUID()}`;
    const response = await SELF.fetch(`${ORIGIN}/api/auth/sign-up/email`, {
        body: JSON.stringify({ email: `${name}@example.test`, name, password: `${name}-password-123` }),
        headers: { "content-type": "application/json", origin: ORIGIN },
        method: "POST",
    });

    if (response.status !== 200) {
        throw new Error(`sign-up for ${label} returned ${String(response.status)}`);
    }

    return response.headers
        .getSetCookie()
        .map((cookie) => cookie.split(";")[0])
        .join("; ");
};

/** Calls one app function over the production RPC route, addressed to the channel's shard. */
const call = async (cookie: string, shard: string, functionPath: string, args: Record<string, unknown>): Promise<Response> =>
    SELF.fetch(`${ORIGIN}/_lunora/rpc`, {
        body: JSON.stringify({ args, functionPath, shardKey: shard }),
        headers: { "content-type": "application/json", cookie, origin: ORIGIN },
        method: "POST",
    });

/** Calls a function and throws unless the app accepted it. */
const callOk = async (cookie: string, shard: string, functionPath: string, args: Record<string, unknown>): Promise<void> => {
    const response = await call(cookie, shard, functionPath, args);

    if (response.status !== 200) {
        throw new Error(`${functionPath} returned ${String(response.status)}`);
    }
};

/**
 * One live socket to a channel's shard, with every frame the server sends recorded in arrival order.
 * `next` resolves on a frame already received or the next one that matches, so a caller never races the server.
 */
class LiveSocket {
    public static async open(cookie: string, shard: string): Promise<LiveSocket> {
        const upgrade = await SELF.fetch(`${ORIGIN}/_lunora/ws?shard=${encodeURIComponent(shard)}`, {
            headers: { cookie, origin: ORIGIN, Upgrade: "websocket" },
        });
        const socket = upgrade.webSocket;

        if (upgrade.status !== 101 || !socket) {
            throw new Error(`live socket to ${shard} returned ${String(upgrade.status)}`);
        }

        socket.accept();

        return new LiveSocket(socket);
    }

    public readonly frames: Frame[] = [];

    private readonly waiters = new Set<Waiter>();

    private constructor(private readonly socket: WebSocket) {
        socket.addEventListener("message", (event) => {
            if (typeof event.data !== "string") {
                return;
            }

            const frame = JSON.parse(event.data) as Frame;

            this.frames.push(frame);

            for (const waiter of this.waiters) {
                if (waiter.matches(frame)) {
                    this.waiters.delete(waiter);
                    waiter.resolve(frame);
                }
            }
        });
    }

    public subscribe(id: string, functionPath: string, args: Record<string, unknown>): void {
        this.socket.send(JSON.stringify({ id, query: { args, functionPath, table: functionPath }, type: "subscribe" }));
    }

    /** The first frame at or after index `from`, sent or still to come, that satisfies `matches`. */
    public next(matches: (frame: Frame) => boolean, from = 0): Promise<Frame> {
        const seen = this.frames.slice(from).find((frame) => matches(frame));

        if (seen) {
            return Promise.resolve(seen);
        }

        return new Promise((resolve) => {
            this.waiters.add({ matches, resolve });
        });
    }

    public close(): void {
        this.socket.close();
    }
}

/**
 * A subscription's own frames. A live subscription is updated two ways: a `data` snapshot when its query re-runs, or a
 * `delta` for a row the shard fans out as the write happens. Either one carries message data, so both count as payload.
 */
const dataFor = (id: string) => (frame: Frame) => frame.id === id && frame.type === "data";
const payloadFor = (id: string) => (frame: Frame) => frame.id === id && (frame.type === "data" || frame.type === "delta");
const errorFor = (id: string) => (frame: Frame) => frame.id === id && frame.type === "error";
/** Whatever the server sends a subscription next: the refusal, or payload that should not reach a non-member. */
const settledFor = (id: string) => (frame: Frame) => errorFor(id)(frame) || payloadFor(id)(frame);

/** The error code the server attached to a subscription error frame. */
const errorCode = (frame: Frame): unknown => (frame.error as { code?: unknown } | undefined)?.code ?? frame.code;

/** Whether any frame carries `text` anywhere in its payload. */
const carries = (frames: Frame[], text: string): boolean => frames.some((frame) => JSON.stringify(frame).includes(text));

/** Whether a frame hands the client message data, as a snapshot or as a row delta. */
const isPayload = (frame: Frame): boolean => frame.type === "data" || frame.type === "delta";

describe("channel membership on a live shard (workerd)", () => {
    beforeAll(migrateSignIn);

    it("stops a leaver's live updates: a member is pushed a message, leaves, then gets a refusal and no later data", async () => {
        expect.assertions(4);

        const channel = channelFor("general");
        const ada = await signUp("ada");
        const grace = await signUp("grace");

        await callOk(ada, channel, "channels:join", { channelId: channel });
        await callOk(grace, channel, "channels:join", { channelId: channel });

        const graceSocket = await LiveSocket.open(grace, channel);

        graceSocket.subscribe("grace-list", "messages:list", { channelId: channel });
        await graceSocket.next(dataFor("grace-list"));

        // A member subscribed to the channel receives a message written by another member.
        await callOk(ada, channel, "messages:send", { channelId: channel, content: "before the leave" });
        await graceSocket.next((frame) => payloadFor("grace-list")(frame) && carries([frame], "before the leave"));

        const mark = graceSocket.frames.length;

        await callOk(grace, channel, "channels:leave", { channelId: channel });

        // A later message by the other member. Ada's own live subscription is the milestone: her socket is pushed the
        // message, so the shard has committed it and fanned it out to every subscriber, the leaver included.
        const adaSocket = await LiveSocket.open(ada, channel);

        adaSocket.subscribe("ada-list", "messages:list", { channelId: channel });
        await adaSocket.next(dataFor("ada-list"));

        await callOk(ada, channel, "messages:send", { channelId: channel, content: "after the leave" });
        await adaSocket.next((frame) => payloadFor("ada-list")(frame) && carries([frame], "after the leave"));

        // What the leaver received since the leave: the refusal, and nothing carrying message data.
        const sinceLeave = graceSocket.frames.slice(mark);
        const refusal = sinceLeave.find(errorFor("grace-list"));

        expect(refusal, "the leaver's subscription should be refused").toBeDefined();
        expect(errorCode(refusal!)).toBe("FORBIDDEN");

        expect(sinceLeave.filter((frame) => isPayload(frame))).toStrictEqual([]);
        expect(carries(sinceLeave, "after the leave")).toBe(false);

        graceSocket.close();
        adaSocket.close();
    });

    it("refuses a signed-in non-member's live list and sends it no data", async () => {
        expect.assertions(4);

        const channel = channelFor("private");
        const ada = await signUp("ada");
        const lin = await signUp("lin");

        await callOk(ada, channel, "channels:join", { channelId: channel });
        await callOk(ada, channel, "messages:send", { channelId: channel, content: "members only" });

        const linSocket = await LiveSocket.open(lin, channel);

        linSocket.subscribe("lin-list", "messages:list", { channelId: channel });

        const refusal = await linSocket.next(settledFor("lin-list"));

        expect(refusal.type).toBe("error");
        expect(errorCode(refusal)).toBe("FORBIDDEN");

        expect(linSocket.frames.filter((frame) => isPayload(frame))).toStrictEqual([]);
        expect(carries(linSocket.frames, "members only")).toBe(false);

        linSocket.close();
    });
});
