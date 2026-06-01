/**
 * Phase 3 verification gate: real `CirrusClient` ↔ real `workerd` worker.
 *
 * Boots the `@cirrus/runtime` Worker (HTTP routes + shard forwarding) on top of
 * a `ShardDO` (Hibernation API + broadcasts) inside Miniflare-managed workerd.
 * The test instantiates the standalone `CirrusClient` with `fetch` and a
 * `WebSocket` polyfill that route through `SELF.fetch`, then asserts:
 *
 * 1. `client.query()` round-trips through `/_cirrus/rpc`.
 * 2. `client.mutation()` captures + replays `x-d1-bookmark`.
 * 3. `client.subscribe()` delivers a real `delta` over a real WebSocket.
 */
import { env, runInDurableObject, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { CirrusClient } from "../../src/cirrus-client.js";
import type { FunctionReference } from "../../src/types.js";
import type { TestShardDO } from "./test-worker.js";

const ref = <Args = unknown, Return = unknown>(name: string): FunctionReference<"query" | "mutation", Args, Return> => {
    return {
        __cirrusRef: name,
    };
};

const rootStub = (): DurableObjectStub<TestShardDO> => {
    const id = env.SHARD.idFromName("__root__");

    return env.SHARD.get(id);
};

const fetchViaSelf: typeof fetch = (...arguments_) => SELF.fetch(...(arguments_ as Parameters<typeof SELF.fetch>));

/**
 * `CirrusClient` wants a `new WebSocket(url)` constructor. workerd doesn't
 * expose one that's reachable from the test context — instead we drive the
 * upgrade through `SELF.fetch` and present the resulting socket via a
 * constructor-shaped wrapper.
 */
class SelfWebSocket {
    public onclose: ((event: unknown) => void) | null = null;

    public onerror: ((event: unknown) => void) | null = null;

    public onmessage: ((event: { data: unknown }) => void) | null = null;

    public onopen: ((event: unknown) => void) | null = null;

    private socket: WebSocket | null = null;

    private pendingSends: string[] = [];

    public constructor(url: string) {
        this.connect(url);
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

    private connect(url: string): void {
        SELF.fetch(url, { headers: { Upgrade: "websocket" } })
            .then((response) => {
                const ws = (response as unknown as { webSocket: WebSocket | null }).webSocket;

                if (!ws) {
                    this.onerror?.({});
                    this.onclose?.({});

                    return false;
                }

                this.socket = ws;
                ws.addEventListener("message", (event) => {
                    this.onmessage?.(event);
                });
                ws.addEventListener("close", (event) => {
                    this.onclose?.(event);
                });
                ws.addEventListener("error", (event) => {
                    this.onerror?.(event);
                });
                ws.accept();

                for (const message of this.pendingSends) {
                    ws.send(message);
                }

                this.pendingSends = [];

                this.onopen?.({});

                return true;
            })
            .catch(() => {
                this.onerror?.({});
                this.onclose?.({});
            });
    }
}

const makeClient = (): CirrusClient =>
    new CirrusClient({
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

describe("cirrusClient (workerd integration)", () => {
    it("query round-trips through /_cirrus/rpc", async () => {
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
        // can't read CirrusClient's internal bookmark store directly.
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

                if (!headers.has("x-d1-bookmark") && new URL(requestUrl).pathname === "/_cirrus/rpc") {
                    headers.set("x-d1-bookmark", "bk-42");
                }

                return new Response(response.body, { headers, status: response.status });
            });
        };

        await runInDurableObject(rootStub(), async (instance) => {
            // eslint-disable-next-line no-param-reassign -- seed the DO instance under test
            instance.rpcResult = { ok: true };
        });

        const client = new CirrusClient({
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
});
