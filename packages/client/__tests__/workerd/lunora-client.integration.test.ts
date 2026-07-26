/// <reference types="@cloudflare/workers-types" />
// This file drives a REAL worker in workerd, so it needs Cloudflare's ambient
// globals. The reference lives here rather than in the package's tsconfig
// `types` array because `src/` is platform-neutral (plan 114 §5.1 rates this
// package none/light) — making the whole package ambient-Cloudflare would let a
// `DurableObjectNamespace` reference slip into shipped code and still compile.

/**
 * Phase 3 verification gate: real `LunoraClient` ↔ real `workerd` worker.
 *
 * Boots the `@lunora/runtime` Worker (HTTP routes + shard forwarding) on top of
 * a `ShardDO` (Hibernation API + broadcasts) inside Miniflare-managed workerd.
 * The test instantiates the standalone `LunoraClient` with `fetch` and a
 * `WebSocket` polyfill that route through `SELF.fetch`, then asserts:
 *
 * 1. `client.query()` round-trips through `/_lunora/rpc`.
 * 2. `client.mutation()` captures + replays `x-d1-bookmark`.
 * 3. `client.subscribe()` delivers a real `delta` over a real WebSocket.
 */
import { env, runInDurableObject, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { LunoraClient } from "../../src/lunora-client";
import type { FunctionReference } from "../../src/types";
import type { TestShardDO } from "./test-worker";

const ref = <Args = unknown, Return = unknown>(name: string): FunctionReference<"query" | "mutation", Args, Return> => {
    return {
        __lunoraRef: name,
    };
};

const rootStub = (): DurableObjectStub<TestShardDO> => {
    const id = env.SHARD.idFromName("__root__");

    return env.SHARD.get(id);
};

const fetchViaSelf: typeof fetch = (...arguments_) => SELF.fetch(...(arguments_ as Parameters<typeof SELF.fetch>));

/**
 * `LunoraClient` wants a `new WebSocket(url)` constructor. workerd doesn't
 * expose one that's reachable from the test context — instead we drive the
 * upgrade through `SELF.fetch` and present the resulting socket via a
 * constructor-shaped wrapper.
 */
class SelfWebSocket {
    private socket: WebSocket | null = null;

    private pendingSends: string[] = [];

    // The client subscribes through the standard `socket.addEventListener(type, fn)`
    // API, so the polyfill must expose it. (It previously exposed only `on*` handler
    // props, which the client no longer uses — the source of the
    // "socket.addEventListener is not a function" failure.)
    private readonly listeners: Record<string, Set<(event: unknown) => void>> = {};

    public constructor(url: string) {
        this.connect(url);
    }

    public addEventListener(type: string, listener: (event: unknown) => void): void {
        this.listeners[type] ??= new Set();
        this.listeners[type].add(listener);
    }

    public removeEventListener(type: string, listener: (event: unknown) => void): void {
        this.listeners[type]?.delete(listener);
    }

    public send(data: string): void {
        if (this.socket) {
            this.socket.send(data);
        } else {
            this.pendingSends.push(data);
        }
    }

    public close(): void {
        this.socket?.close();
    }

    private dispatch(type: string, event: unknown): void {
        for (const listener of this.listeners[type] ?? new Set<(event: unknown) => void>()) {
            listener(event);
        }
    }

    private connect(url: string): void {
        // The client builds a browser `wss://`/`ws://` URL, but workerd's
        // `SELF.fetch` upgrades over `https://`/`http://` — rewrite the scheme so
        // the upgrade actually lands on the worker (a `wss://` URL silently fails
        // to upgrade, which left the DO with zero registered sockets).
        const httpUrl = url.replace(/^wss:\/\//, "https://").replace(/^ws:\/\//, "http://");

        SELF.fetch(httpUrl, { headers: { Upgrade: "websocket" } })
            .then((response) => {
                const ws = (response as unknown as { webSocket: WebSocket | null }).webSocket;

                if (!ws) {
                    this.dispatch("error", {});
                    this.dispatch("close", {});

                    return false;
                }

                this.socket = ws;
                ws.addEventListener("message", (event) => {
                    this.dispatch("message", event);
                });
                ws.addEventListener("close", (event) => {
                    this.dispatch("close", event);
                });
                ws.addEventListener("error", (event) => {
                    this.dispatch("error", event);
                });
                ws.accept();

                for (const message of this.pendingSends) {
                    ws.send(message);
                }

                this.pendingSends = [];

                this.dispatch("open", {});

                return true;
            })
            .catch(() => {
                this.dispatch("error", {});
                this.dispatch("close", {});
            });
    }
}

const makeClient = (): LunoraClient =>
    new LunoraClient({
        fetch: fetchViaSelf,
        reconnect: { initialDelayMs: 10, maxDelayMs: 50 },
        url: "https://test.invalid",
        WebSocket: SelfWebSocket as unknown as typeof WebSocket,
    });

const waitFor = async (predicate: () => boolean | Promise<boolean>, { intervalMs = 10, timeoutMs = 2000 } = {}): Promise<void> => {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
        // eslint-disable-next-line no-await-in-loop -- polling loop: each predicate check must resolve before the next interval
        if (await predicate()) {
            return;
        }

        // eslint-disable-next-line no-await-in-loop -- polling loop: wait out the interval before re-checking
        await new Promise((resolve) => {
            setTimeout(resolve, intervalMs);
        });
    }

    throw new Error(`waitFor: predicate never became true within ${timeoutMs.toString()}ms`);
};

describe("lunoraClient (workerd integration)", () => {
    it("query round-trips through /_lunora/rpc", async () => {
        expect.hasAssertions();

        await runInDurableObject(rootStub(), async (instance) => {
            // eslint-disable-next-line no-param-reassign -- seed the DO instance under test
            instance.rpcResult = { id: "u-1", name: "alice" };
        });

        const client = makeClient();

        try {
            const result = await client.query(ref<{ limit: number }, { id: string; name: string }>("users:list"), { limit: 10 });

            expect(result).toEqual({ id: "u-1", name: "alice" });

            await runInDurableObject(rootStub(), async (instance) => {
                expect(instance.lastRpcCall).toEqual({ args: { limit: 10 }, functionPath: "users:list" });
            });
        } finally {
            client.close();
        }
    });

    it("mutation captures x-d1-bookmark and replays it on the next query", async () => {
        expect.assertions(3);

        // Replace `fetch` with a wrapper that watches outbound headers — we
        // can't read LunoraClient's internal bookmark store directly.
        const requestHeaders: Headers[] = [];

        const trackingFetch: typeof fetch = (input, init) => {
            requestHeaders.push(new Headers(init?.headers));

            // Have the worker echo a synthetic bookmark on the mutation response.
            // The shard sets the response bookmark via `setOutboundBookmark`,
            // which the runtime then forwards. We piggy-back by stamping it
            // into the response that comes back from SELF.
            return SELF.fetch(input as never, init as never).then((response: Response) => {
                const headers = new Headers(response.headers);

                let requestUrl: string;

                if (typeof input === "string") {
                    requestUrl = input;
                } else if (input instanceof URL) {
                    requestUrl = input.href;
                } else {
                    requestUrl = (input as Request).url;
                }

                if (!headers.has("x-d1-bookmark") && new URL(requestUrl).pathname === "/_lunora/rpc") {
                    headers.set("x-d1-bookmark", "bk-42");
                }

                return new Response(response.body, { headers, status: response.status });
            });
        };

        await runInDurableObject(rootStub(), async (instance) => {
            // eslint-disable-next-line no-param-reassign -- seed the DO instance under test
            instance.rpcResult = { ok: true };
        });

        const client = new LunoraClient({
            fetch: trackingFetch,
            reconnect: { initialDelayMs: 10, maxDelayMs: 50 },
            url: "https://test.invalid",
            WebSocket: SelfWebSocket as unknown as typeof WebSocket,
        });

        try {
            await client.mutation(ref<{ text: string }, { ok: boolean }>("messages:send"), { text: "hi" });
            await client.query(ref<Record<string, unknown>, { ok: boolean }>("messages:list"), {});

            expect(requestHeaders).toHaveLength(2);
            expect(requestHeaders[0]!.get("x-d1-bookmark")).toBeNull();
            expect(requestHeaders[1]!.get("x-d1-bookmark")).toBe("bk-42");
        } finally {
            client.close();
        }
    });

    it("subscribe receives a broadcast delta over a real WebSocket", async () => {
        expect.assertions(1);

        const client = makeClient();
        const received: unknown[] = [];

        try {
            client.subscribe(ref("messages:list"), {}, (value) => {
                received.push(value);
            });

            // Wait until the WS upgraded, subscribed, and the DO has registered
            // the socket. `webSocketMessage` runs server-side asynchronously.
            await waitFor(async () => {
                let count = 0;

                await runInDurableObject(rootStub(), (_instance, state) => {
                    count = state.getWebSockets().length;
                });

                return count >= 1;
            });

            // Trigger a broadcast from inside the DO. The DO must call
            // `broadcastDelta` from its own context — calling it from outside
            // via a stub method won't see the runtime's WS attachments.
            await runInDurableObject(rootStub(), async (instance) => {
                instance.broadcast({ key: "m-1", op: "insert", row: { id: "m-1", text: "hi" }, table: "messages:list" });
            });

            await waitFor(() => received.length > 0);

            expect(received[0]).toEqual({ key: "m-1", op: "insert", row: { id: "m-1", text: "hi" }, table: "messages:list" });
        } finally {
            client.close();
        }
    });

    it("subscribes with bigint/Date args end-to-end: decode-at-entry, real-value seed, attachment fidelity (plan 090)", async () => {
        expect.assertions(3);

        const client = makeClient();
        const received: unknown[] = [];
        const args = { at: new Date(5000), since: 123n };

        try {
            // Pre-change this threw client-side at the registry key; the frame's
            // JSON.stringify would have thrown on the bigint anyway.
            client.subscribe(ref("counters:since"), args, (value) => {
                received.push(value);
            });

            // The seed (executeSubscription echo) ships the DECODED args back as
            // the subscription's first value — the full client → workerd → client
            // round-trip preserves the real bigint/Date.
            await waitFor(() => received.length > 0);

            expect(received[0]).toStrictEqual({ args: { at: new Date(5000), since: 123n }, functionPath: "counters:since" });

            await runInDurableObject(rootStub(), async (instance, state) => {
                // The DO's executeSubscription ran with REAL values (not tagged arrays).
                expect(instance.lastSubscribeArgs).toStrictEqual({ at: new Date(5000), since: 123n });

                // The hibernation attachment (real workerd structured clone) carries
                // the decoded args, so a post-hibernation re-execution sees them too.
                const [socket] = state.getWebSockets();
                const attachment = socket?.deserializeAttachment() as { subs: Record<string, { args?: Record<string, unknown> }> };
                const stored = Object.values(attachment.subs).find((sub) => sub.args?.["since"] !== undefined);

                expect(stored?.args).toStrictEqual({ at: new Date(5000), since: 123n });
            });
        } finally {
            client.close();
        }
    });
});
