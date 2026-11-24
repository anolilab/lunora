import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { decodeIdentityHeader } from "../../../shared/identity-header";
import { notifySessionChanged } from "../../../shared/session-change";
import { LunoraClient } from "../src/lunora-client";
import type { FunctionReference } from "../src/types";

/**
 * A cookie session changed in ANOTHER tab.
 *
 * The cookie jar is shared by every tab of a browser profile, so a sign-out in
 * one tab signs every tab out — but the other tabs' Lunora clients see nothing
 * change, and their sockets keep serving the previous user's rows until they
 * happen to reconnect. The tab that made the change says so on a
 * `BroadcastChannel`; better-auth's own cross-tab `storage` message for a
 * sign-out is a second trigger for apps without the plugin. A receiving tab
 * re-resolves exactly as it would for a change of its own, and never re-posts.
 *
 * Node's `BroadcastChannel` delivers across instances in one process, so a raw
 * channel here stands in for the other tab.
 */

const CHANNEL = "lunora:session-change";

const fnRef = (ref: string): FunctionReference => {
    return { __lunoraRef: ref };
};

/** Every `BroadcastChannel` opened while the stub below is installed, so a test can wait on the one the code under test listens on. */
const channels: TrackedChannel[] = [];

class TrackedChannel extends BroadcastChannel {
    public closed = false;

    public constructor(name: string) {
        super(name);
        channels.push(this);
    }

    public override close(): void {
        this.closed = true;
        super.close();
    }
}

/**
 * The channel this tab hears the other tabs on (`shared/session-change.ts`). The first client opens
 * it, so it is the first open one on the name — the tests open their own only after a client.
 */
const sessionChannel = (): TrackedChannel => {
    const open = channels.find((channel) => channel.name === CHANNEL && !channel.closed);

    if (open === undefined) {
        throw new Error("no client is listening for session changes");
    }

    return open;
};

/**
 * Resolves once `channel` has dispatched a message matching `match`. Cross-instance delivery is a
 * real macrotask in Node, and a channel runs its listeners in registration order, so the code under
 * test's own listener has handled the message by then.
 */
const heard = (channel: BroadcastChannel, match: (data: unknown) => boolean): Promise<void> =>
    new Promise((resolve) => {
        const onMessage = (event: MessageEvent): void => {
            if (match(event.data)) {
                channel.removeEventListener("message", onMessage);
                resolve();
            }
        };

        channel.addEventListener("message", onMessage);
    });

const typeIs =
    (type: string) =>
    (data: unknown): boolean =>
        (data as { type?: unknown } | null)?.type === type;

const isMarker = typeIs("test:marker");

/**
 * Resolves once `channel` has dispatched everything already posted to it. One channel's messages
 * arrive in the order they were posted, from whichever sender, so a marker posted now comes last.
 */
const drained = async (channel: BroadcastChannel): Promise<void> => {
    const sender = new BroadcastChannel(channel.name);
    const marker = heard(channel, isMarker);

    sender.postMessage({ type: "test:marker" });
    await marker;
    sender.close();
};

/** Count this client's session probes as they settle, so a test can wait for the next one's answer to be adopted. */
const watchProbes = (client: LunoraClient): { next: () => Promise<void> } => {
    const getCurrentUser = client.getCurrentUser.bind(client);
    let settled = 0;
    const waiters: { count: number; resolve: () => void }[] = [];

    vi.spyOn(client, "getCurrentUser").mockImplementation(async () => {
        try {
            return await getCurrentUser();
        } finally {
            settled += 1;

            for (const waiter of waiters.filter((entry) => entry.count <= settled)) {
                waiters.splice(waiters.indexOf(waiter), 1);
                waiter.resolve();
            }
        }
    });

    return {
        /** Resolves once the probe after every one settled so far has settled. Call before the trigger. */
        next: (): Promise<void> =>
            new Promise((resolve) => {
                waiters.push({ count: settled + 1, resolve });
            }),
    };
};

interface MockSocket {
    closed: boolean;
    drop: () => void;
    open: () => void;
    receive: (payload: unknown) => void;
    sent: Record<string, unknown>[];
}

const createMockWebSocket = (sockets: MockSocket[]): typeof WebSocket => {
    class WS {
        public readyState = 0;

        private readonly sent: Record<string, unknown>[] = [];

        private readonly listeners = new Map<string, ((event?: unknown) => void)[]>();

        private readonly record: MockSocket;

        public constructor() {
            this.record = {
                closed: false,
                drop: () => {
                    this.close();
                },
                open: () => {
                    this.readyState = 1;
                    this.emit("open");
                },
                receive: (payload: unknown) => {
                    this.emit("message", { data: JSON.stringify(payload) });
                },
                sent: this.sent,
            };
            sockets.push(this.record);
        }

        public addEventListener(type: string, listener: (event?: unknown) => void): void {
            this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
        }

        public close(): void {
            this.readyState = 3;
            this.record.closed = true;
            this.emit("close", { code: 1000 });
        }

        public removeEventListener(type: string): void {
            this.listeners.delete(type);
        }

        public send(raw: string): void {
            this.sent.push(JSON.parse(raw) as Record<string, unknown>);
        }

        private emit(type: string, event?: unknown): void {
            for (const listener of this.listeners.get(type) ?? []) {
                listener(event);
            }
        }
    }

    return WS as unknown as typeof WebSocket;
};

/** A server whose cookie jar the test flips, and which refuses a replay naming anyone else. */
const createCookieServer = (initialUser: null | string) => {
    const state = { user: initialUser };
    const applied: { asUser: null | string; functionPath: string }[] = [];
    const fetchImpl = vi.fn<typeof fetch>(async (input: unknown, init?: RequestInit) => {
        if ((input as string).includes("get-session")) {
            return Response.json(state.user === null ? {} : { user: { id: state.user } });
        }

        const expected = new Headers(init?.headers).get("x-lunora-expect-subject");

        if (expected !== null && decodeIdentityHeader(expected)?.subject !== state.user) {
            return Response.json({ error: { code: "IDENTITY_MISMATCH", message: "session changed" } }, { status: 409 });
        }

        const body = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as { functionPath?: string };

        applied.push({ asUser: state.user, functionPath: body.functionPath ?? "" });

        return Response.json({ result: { ok: true } });
    });
    const probes = (): number => fetchImpl.mock.calls.filter((call) => (call[0] as string).includes("get-session")).length;

    return { applied, fetchImpl, probes, state };
};

const FAST_RECONNECT = { initialDelayMs: 1, jitter: false, maxDelayMs: 1 } as const;

/** A cookie-session client, signed in as `user`, with one live query on an open socket. */
const liveClient = async (server: ReturnType<typeof createCookieServer>) => {
    const sockets: MockSocket[] = [];
    const client = new LunoraClient({
        fetch: server.fetchImpl,
        heartbeatIntervalMs: 0,
        reconnect: FAST_RECONNECT,
        url: "http://app.test",
        WebSocket: createMockWebSocket(sockets),
    });
    let identityChanges = 0;

    client.onIdentityChange(() => {
        identityChanges += 1;
    });
    await client.getCurrentUser();
    client.subscribe(fnRef("notes:mine"), {}, () => {});

    if (sockets[0] === undefined) {
        throw new Error("the live query opened no socket");
    }

    sockets[0].open();

    return { client, identityChanges: () => identityChanges, probes: watchProbes(client), sockets };
};

/** `storage` listeners the code under test registers on the page. */
const storageListeners: ((event: { key: null | string; newValue: null | string }) => void)[] = [];

/** Another tab's `localStorage` write, as the browser reports it here. */
const storageEvent = (key: string, value: unknown): void => {
    for (const listener of storageListeners) {
        listener({ key, newValue: JSON.stringify(value) });
    }
};

describe("a session change in another tab", () => {
    beforeEach(() => {
        storageListeners.length = 0;
        channels.length = 0;
        vi.stubGlobal("BroadcastChannel", TrackedChannel);
        vi.stubGlobal("document", {});
        vi.stubGlobal("addEventListener", (type: string, listener: (event: { key: null | string; newValue: null | string }) => void) => {
            if (type === "storage") {
                storageListeners.push(listener);
            }
        });
        vi.stubGlobal("removeEventListener", (type: string, listener: (event: { key: null | string; newValue: null | string }) => void) => {
            if (type === "storage") {
                storageListeners.splice(storageListeners.indexOf(listener), 1);
            }
        });
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it("retires A's session in every client of this tab, and nothing is re-posted", async () => {
        expect.assertions(5);

        const server = createCookieServer("user-a");
        const first = await liveClient(server);
        const second = await liveClient(server);
        const otherTab = new BroadcastChannel(CHANNEL);
        const heardOnChannel: unknown[] = [];
        const observer = new BroadcastChannel(CHANNEL);
        const reResolved = Promise.all([first.probes.next(), second.probes.next()]);

        observer.addEventListener("message", (event: MessageEvent) => {
            if (!isMarker(event.data)) {
                heardOnChannel.push(event.data);
            }
        });

        // The other tab signs out.
        server.state.user = null;
        otherTab.postMessage({ tab: "other-tab", type: "lunora:session-change" });
        await reResolved;
        // A re-post would have gone out while this tab handled the message, ahead of the marker.
        await drained(observer);

        expect([first.client.currentIdentity(), second.client.currentIdentity()]).toStrictEqual([null, null]);
        expect([first.identityChanges(), second.identityChanges()]).toStrictEqual([1, 1]);
        expect([first.sockets[0]?.closed, second.sockets[0]?.closed]).toStrictEqual([true, true]);
        // Only the other tab's own message went over the channel: a receiver
        // re-resolves, it never re-announces, so two tabs cannot ping-pong.
        expect(heardOnChannel).toStrictEqual([{ tab: "other-tab", type: "lunora:session-change" }]);
        expect(server.probes()).toBe(4);

        otherTab.close();
        observer.close();
        first.client.close();
        second.client.close();
    });

    it("tells the other tabs when this one signals, and probes here once per client, not twice", async () => {
        expect.assertions(2);

        const server = createCookieServer("user-a");
        const { client } = await liveClient(server);
        const listening = sessionChannel();
        const otherTab = new BroadcastChannel(CHANNEL);
        const heardInOtherTab: unknown[] = [];

        otherTab.addEventListener("message", (event: MessageEvent) => heardInOtherTab.push(event.data));

        const before = server.probes();
        const otherTabHeard = heard(otherTab, typeIs("lunora:session-change"));
        // The echo of this tab's own post, which its listener must ignore.
        const echoHeard = heard(listening, typeIs("lunora:session-change"));

        await notifySessionChanged();
        await Promise.all([otherTabHeard, echoHeard]);

        expect(heardInOtherTab).toHaveLength(1);
        // Its own post comes back over the channel too; that echo is ignored.
        expect(server.probes() - before).toBe(1);

        otherTab.close();
        client.close();
    });

    it("re-resolves on better-auth's cross-tab sign-out message, and only on a sign-out", async () => {
        expect.assertions(3);

        const server = createCookieServer("user-a");
        const { client, identityChanges, probes } = await liveClient(server);
        const before = server.probes();

        // A profile update in another tab cannot change who is signed in. A `storage` event is
        // dispatched synchronously, and a probe it triggers is sent before the listener returns.
        storageEvent("better-auth.message", { data: { trigger: "updateUser" }, event: "session" });

        expect(server.probes()).toBe(before);

        const reResolved = probes.next();

        server.state.user = null;
        storageEvent("better-auth.message", { data: { trigger: "signout" }, event: "session" });
        await reResolved;

        expect(client.currentIdentity()).toBeNull();
        expect(identityChanges()).toBe(1);

        client.close();
    });

    it("still constructs, and still hears better-auth's sign-out, where BroadcastChannel throws", async () => {
        expect.assertions(3);

        // An opaque-origin document (a sandboxed iframe, `data:`) refuses to
        // construct a channel at all.
        vi.stubGlobal(
            "BroadcastChannel",
            // Constructible, so `new` reaches the throw the browser raises.
            class RefusingBroadcastChannel extends EventTarget {
                public constructor() {
                    super();

                    throw new DOMException("The operation is insecure.", "SecurityError");
                }
            },
        );

        const server = createCookieServer("user-a");
        const { client, identityChanges, probes } = await liveClient(server);

        await expect(notifySessionChanged()).resolves.toBeUndefined();

        const reResolved = probes.next();

        server.state.user = null;
        storageEvent("better-auth.message", { data: { trigger: "signout" }, event: "session" });
        await reResolved;

        expect(client.currentIdentity()).toBeNull();
        expect(identityChanges()).toBe(1);

        client.close();
    });

    it("stops listening once closed", async () => {
        expect.assertions(2);

        const server = createCookieServer("user-a");
        const { client } = await liveClient(server);
        const listening = sessionChannel();

        client.close();

        const before = server.probes();

        // The last client gone, the tab hears the other tabs on nothing: a closed channel is
        // delivered no message, and a `storage` event reaches only the listeners still registered.
        expect(listening.closed).toBe(true);

        storageEvent("better-auth.message", { data: { trigger: "signout" }, event: "session" });

        expect(server.probes()).toBe(before);
    });

    it("a follower tab's queued write is never replayed as the user signed in elsewhere", async () => {
        expect.assertions(5);

        // The coordinator elects on timers; frozen, this tab never claims leadership on its own.
        vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout"] });

        const server = createCookieServer("user-a");
        const client = new LunoraClient({
            crossTabSync: true,
            fetch: server.fetchImpl,
            offlineQueue: { queueBeforeFirstConnect: true },
            url: "http://app.test",
        });

        try {
            await client.getCurrentUser();

            const bridgeName = `lunora-bridge::http://app.test::${client.currentIdentity() ?? "anon"}`;
            const coordinator = channels.find((channel) => channel.name === bridgeName && !channel.closed);

            if (coordinator === undefined) {
                throw new Error("the client is not coordinating on its identity's channel");
            }

            const bridge = new BroadcastChannel(bridgeName);
            const leaderKnown = heard(coordinator, typeIs("heartbeat"));

            // A leader tab that outranks this one, so it stays a follower.
            bridge.postMessage({ tabId: "aaa-leader-tab", ts: Date.now(), type: "heartbeat" });
            await leaderKnown;

            const settled: (string | undefined)[] = [];
            const rejected = Promise.withResolvers<undefined>();

            client.onMutationSettled((event) => {
                settled.push((event.error as { code?: string } | undefined)?.code);
                rejected.resolve(undefined);
            });

            // Queued as A while the leader reports no connection.
            const pending = client.mutation(fnRef("notes:add"), { text: "from A" }).catch((error: unknown) => error);

            expect(client.pendingCount()).toBe(1);

            // Another tab signs A out and B in, and says so.
            server.state.user = "user-b";
            const otherTab = new BroadcastChannel(CHANNEL);

            otherTab.postMessage({ tab: "other-tab", type: "lunora:session-change" });
            otherTab.close();
            await rejected.promise;

            // The leader comes back on the channel B's identity coordinates on: the follower flushes
            // whatever it still holds over HTTP, which must be nothing of A's.
            const rejoined = channels.find((channel) => channel.name === `lunora-bridge::http://app.test::subj:user-b` && !channel.closed);

            if (rejoined === undefined) {
                throw new Error("the client did not move to B's channel");
            }

            const bridgeB = new BroadcastChannel(rejoined.name);
            const statusHandled = heard(rejoined, typeIs("connection-status"));

            bridgeB.postMessage({ status: "connected", tabId: "aaa-leader-tab", type: "connection-status" });
            await statusHandled;

            expect(client.currentIdentity()).toBe("subj:user-b");
            // Nothing is left to flush, so nothing of A's can reach the server as B.
            expect(client.pendingCount()).toBe(0);
            expect(server.applied.filter((entry) => entry.functionPath === "notes:add")).toStrictEqual([]);
            expect(settled).toStrictEqual(["OFFLINE_IDENTITY_CHANGED"]);

            bridge.close();
            bridgeB.close();
            client.close();
            await pending;
        } finally {
            vi.useRealTimers();
        }
    });

    it("does nothing off the browser", async () => {
        expect.assertions(1);

        vi.unstubAllGlobals();
        // Only the tracking: still no `document`, so this is not a page.
        vi.stubGlobal("BroadcastChannel", TrackedChannel);

        const server = createCookieServer("user-a");
        const { client } = await liveClient(server);

        // Nothing opened a channel to hear the other tabs on, so no other tab's post can reach this one.
        expect(channels.filter((channel) => channel.name === CHANNEL)).toStrictEqual([]);

        client.close();
    });
});
