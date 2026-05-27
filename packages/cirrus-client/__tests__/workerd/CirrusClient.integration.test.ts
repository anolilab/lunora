/**
 * Phase 3 verification gate: real `CirrusClient` ↔ real `workerd` worker.
 *
 * Boots the `cirrus-runtime` Worker (HTTP routes + shard forwarding) on top of
 * a `ShardDO` (Hibernation API + broadcasts) inside Miniflare-managed workerd.
 * The test instantiates the standalone `CirrusClient` with `fetch` and a
 * `WebSocket` polyfill that route through `SELF.fetch`, then asserts:
 *
 *   1. `client.query()` round-trips through `/_cirrus/rpc`.
 *   2. `client.mutation()` captures + replays `x-d1-bookmark`.
 *   3. `client.subscribe()` delivers a real `delta` over a real WebSocket.
 */
import { env, runInDurableObject, SELF } from "cloudflare:test";
import { describe, expect, test } from "vitest";

import { CirrusClient } from "../../src/CirrusClient.js";
import type { FunctionReference } from "../../src/types.js";
import type { TestShardDO } from "./test-worker.js";

const ref = <Args = unknown, Return = unknown>(name: string): FunctionReference<"query" | "mutation", Args, Return> => ({
    __cirrusRef: name,
});

const rootStub = (): DurableObjectStub<TestShardDO> => {
    const id = env.SHARD.idFromName("__root__");

    return env.SHARD.get(id) as DurableObjectStub<TestShardDO>;
};

const fetchViaSelf: typeof fetch = (...arguments_) => SELF.fetch(...(arguments_ as Parameters<typeof SELF.fetch>)) as unknown as Promise<Response>;

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

    private connect(url: string): void {
        SELF.fetch(url, { headers: { Upgrade: "websocket" } })
            .then((response) => {
                const ws = (response as unknown as { webSocket: WebSocket | null }).webSocket;

                if (!ws) {
                    this.onerror?.({});
                    this.onclose?.({});

                    return;
                }

                this.socket = ws;
                ws.addEventListener("message", (event) => {
                    this.onmessage?.(event as unknown as { data: unknown });
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
            })
            .catch(() => {
                this.onerror?.({});
                this.onclose?.({});
            });
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
}

const makeClient = (): CirrusClient =>
    new CirrusClient({
        url: "https://test.invalid",
        fetch: fetchViaSelf,
        WebSocket: SelfWebSocket as unknown as typeof WebSocket,
        reconnect: { initialDelayMs: 10, maxDelayMs: 50 },
    });

const waitFor = async (predicate: () => boolean | Promise<boolean>, { timeoutMs = 2000, intervalMs = 10 } = {}): Promise<void> => {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
        if (await predicate()) {
            return;
        }

        await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }

    throw new Error(`waitFor: predicate never became true within ${timeoutMs}ms`);
};

describe("cirrusClient (workerd integration)", () => {
    test("query round-trips through /_cirrus/rpc", async () => {
        await runInDurableObject(rootStub(), async (instance) => {
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

    test("mutation captures x-d1-bookmark and replays it on the next query", async () => {
        // Replace `fetch` with a wrapper that watches outbound headers — we
        // can't read CirrusClient's internal bookmark store directly.
        const requestHeaders: Headers[] = [];

        const trackingFetch: typeof fetch = (input, init) => {
            requestHeaders.push(new Headers(init?.headers as HeadersInit));

            // Have the worker echo a synthetic bookmark on the mutation response.
            // The shard sets the response bookmark via `setOutboundBookmark`,
            // which the runtime then forwards. We piggy-back by stamping it
            // into the response that comes back from SELF.
            return SELF.fetch(input as never, init as never).then((response: Response) => {
                const headers = new Headers(response.headers);

                if (!headers.has("x-d1-bookmark") && new URL((input as Request | URL).toString()).pathname === "/_cirrus/rpc") {
                    headers.set("x-d1-bookmark", "bk-42");
                }

                return new Response(response.body, { headers, status: response.status });
            }) as unknown as Promise<Response>;
        };

        await runInDurableObject(rootStub(), async (instance) => {
            instance.rpcResult = { ok: true };
        });

        const client = new CirrusClient({
            url: "https://test.invalid",
            fetch: trackingFetch,
            WebSocket: SelfWebSocket as unknown as typeof WebSocket,
            reconnect: { initialDelayMs: 10, maxDelayMs: 50 },
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

    test("subscribe receives a broadcast delta over a real WebSocket", async () => {
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
