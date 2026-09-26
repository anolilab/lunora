import { describe, expect, it, vi } from "vitest";

import { LunoraClient } from "../src/lunora-client";
import type { FunctionReference } from "../src/types";

/**
 * A flush pass gates every queued write against the identity in effect when it
 * starts, then awaits the network once per request. A `setAuthToken` landing
 * during one of those awaits must not change the bearer the rest of the pass
 * sends: the writes were gated as the previous user's, and a bearer request
 * carries no `expectSubject` the worker could refuse a mismatch on. The token is
 * pinned for the pass; the next pass re-gates whatever is left under the new one.
 */

const fnRef = (ref: string): FunctionReference => {
    return { __lunoraRef: ref };
};

const settle = async (): Promise<void> => {
    for (let index = 0; index < 10; index += 1) {
        // eslint-disable-next-line no-await-in-loop -- intentional sequential drain of promise ticks
        await new Promise((resolve) => {
            setTimeout(resolve, 0);
        });
    }
};

const sockets: { open: () => void }[] = [];

const createMockWebSocket = (): typeof WebSocket => {
    class WS {
        public readyState = 0;

        private readonly listeners = new Map<string, ((event?: unknown) => void)[]>();

        public constructor() {
            sockets.push({
                open: () => {
                    this.readyState = 1;

                    for (const listener of this.listeners.get("open") ?? []) {
                        listener();
                    }
                },
            });
        }

        public addEventListener(type: string, listener: (event?: unknown) => void): void {
            this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
        }

        public close(): void {
            this.readyState = 3;
        }

        public removeEventListener(type: string): void {
            this.listeners.delete(type);
        }

        // eslint-disable-next-line class-methods-use-this -- replays under test ride HTTP, not the socket
        public send(): void {}
    }

    return WS as unknown as typeof WebSocket;
};

const json = (body: unknown, status = 200): Response => Response.json(body, { headers: { "content-type": "application/json" }, status });

/** Answer every slot of a batch, except the ids in `omit` (the client re-queues a slot the server never returned). */
const batchResponse = (init: RequestInit, omit: ReadonlySet<number> = new Set()): Response => {
    const { calls } = JSON.parse(init.body as string) as { calls: { id: number }[] };

    return json({
        results: calls
            .filter((call) => !omit.has(call.id))
            .map((call) => {
                return { body: { result: { ok: true } }, id: call.id };
            }),
    });
};

const bearerOf = (init: RequestInit): string | undefined => (init.headers as Record<string, string>)["authorization"];

type Fetch = (url: string, init: RequestInit) => Promise<Response>;

const setup = (fetchImpl: Fetch) => {
    sockets.length = 0;

    const fetchMock = vi.fn<Fetch>(fetchImpl);
    const client = new LunoraClient({
        fetch: fetchMock as unknown as typeof fetch,
        heartbeatIntervalMs: 0,
        offlineQueue: { queueBeforeFirstConnect: true },
        url: "http://app.test",
        WebSocket: createMockWebSocket(),
    });
    const settled: { code?: string; status: string }[] = [];

    client.onMutationSettled((event) => {
        settled.push({ code: (event.error as { code?: string } | undefined)?.code, status: event.status });
    });

    client.setAuthToken("token-a", "user-a");
    client.subscribe(fnRef("todos.list"), {}, () => {});

    const queue = (count: number): Promise<unknown>[] =>
        Array.from({ length: count }, (_, index) =>
            client.mutation(fnRef("todos.add"), { index }).then(
                () => "committed",
                (error: unknown) => String((error as { code?: string }).code),
            ),
        );

    return { client, fetchMock, queue, settled };
};

const replayCalls = (fetchMock: ReturnType<typeof vi.fn<Fetch>>) =>
    fetchMock.mock.calls.filter(([url]) => url.endsWith("/_lunora/rpc-batch") || url.endsWith("/_lunora/rpc"));

describe("offline flush pins the bearer it gated on", () => {
    it("batched: every chunk of the pass carries the gated token after a mid-flush swap", async () => {
        expect.hasAssertions();

        let swapped = false;
        const { client, fetchMock, queue } = setup(async (_url, init) => {
            if (!swapped) {
                swapped = true;
                client.setAuthToken("token-b", "user-b");
            }

            return batchResponse(init);
        });

        // 501 writes: one full 500-entry chunk, then a second request for the last.
        const outcomes = queue(501);

        await settle();
        sockets.at(-1)?.open();
        await settle();

        const bearers = replayCalls(fetchMock).map(([, init]) => bearerOf(init));

        expect(bearers).toStrictEqual(["Bearer token-a", "Bearer token-a"]);

        const results = await Promise.all(outcomes);

        expect(results.filter((result) => result === "committed")).toHaveLength(501);

        client.close();
    });

    it("sequential: a refusal of the gated token after a same-user refresh does not ask for another refresh, and the next pass sends under the new token", async () => {
        expect.hasAssertions();

        let calls = 0;
        const { client, fetchMock, queue, settled } = setup(async () => {
            calls += 1;

            if (calls === 1) {
                // The app refreshes while the lone replay is in flight, and the
                // stale token it carried is refused.
                client.setAuthToken("token-a2", "user-a");

                return json({ error: { code: "UNAUTHORIZED", message: "token expired" } }, 401);
            }

            return json({ result: { ok: true } });
        });
        const expired = vi.fn<() => void>();

        client.onTokenExpired(expired);

        const [outcome] = queue(1);

        await settle();
        sockets.at(-1)?.open();
        await settle();

        const bearers = replayCalls(fetchMock).map(([, init]) => bearerOf(init));

        expect(bearers).toStrictEqual(["Bearer token-a", "Bearer token-a2"]);
        expect(expired).toHaveBeenCalledTimes(0);
        await expect(outcome).resolves.toBe("committed");
        expect(settled).toStrictEqual([{ code: undefined, status: "committed" }]);

        client.close();
    });

    it("the pass after a swap to another user re-gates what is left: rejected, never sent with the new bearer", async () => {
        expect.hasAssertions();

        let calls = 0;
        const { client, fetchMock, queue, settled } = setup(async (_url, init) => {
            calls += 1;

            if (calls === 1) {
                client.setAuthToken("token-b", "user-b");

                // Slot 0 of the first chunk never comes back, so it is re-queued
                // for the next pass.
                return batchResponse(init, new Set([0]));
            }

            return batchResponse(init);
        });

        const outcomes = queue(501);

        await settle();
        sockets.at(-1)?.open();
        await settle();

        const bearers = replayCalls(fetchMock).map(([, init]) => bearerOf(init));

        expect(bearers).toStrictEqual(["Bearer token-a", "Bearer token-a"]);

        const results = await Promise.all(outcomes);

        expect(results.filter((result) => result === "committed")).toHaveLength(500);
        expect(results.filter((result) => result === "OFFLINE_IDENTITY_CHANGED")).toHaveLength(1);
        expect(settled.filter((event) => event.code === "OFFLINE_IDENTITY_CHANGED")).toHaveLength(1);

        client.close();
    });

    it("a normal RPC issued mid-flush uses the live token, while the pass keeps the gated one", async () => {
        expect.hasAssertions();

        let swapped = false;
        let midFlushQuery: Promise<unknown> | undefined;
        const { client, fetchMock, queue } = setup(async (url, init) => {
            if (url.endsWith("/_lunora/rpc")) {
                return json({ result: "live" });
            }

            if (!swapped) {
                swapped = true;
                client.setAuthToken("token-b", "user-b");
                midFlushQuery = client.query(fnRef("todos.count"), {});
            }

            return batchResponse(init);
        });

        const outcomes = queue(501);

        await settle();
        sockets.at(-1)?.open();
        await settle();

        await expect(midFlushQuery).resolves.toBe("live");

        const byPath = (suffix: string) => fetchMock.mock.calls.filter(([url]) => url.endsWith(suffix)).map(([, init]) => bearerOf(init));

        expect(byPath("/_lunora/rpc")).toStrictEqual(["Bearer token-b"]);
        expect(byPath("/_lunora/rpc-batch")).toStrictEqual(["Bearer token-a", "Bearer token-a"]);

        await Promise.all(outcomes);
        client.close();
    });
});

/**
 * The same guarantee across the public API: a durable outbox outside the
 * built-in queue judges a write with `replayIdentityVerdict` and sends it with a
 * separate `mutation` call, so the credential the verdict judged has to ride
 * into that call rather than be re-read there.
 */
describe("replayIdentityVerdict's credential", () => {
    it("sends with the judged token after a swap, is single use, and is refused by another client", async () => {
        expect.assertions(5);

        const bearers: (string | undefined)[] = [];
        const fetchMock = vi.fn<typeof fetch>(async (_input, init) => {
            bearers.push((init?.headers as Record<string, string>).authorization);

            return json({ result: { ok: true } });
        });
        const client = new LunoraClient({ fetch: fetchMock, url: "https://app.example" });
        const other = new LunoraClient({ fetch: fetchMock, url: "https://app.example" });

        client.setAuthToken("token-a", "user-a");

        const judged = client.replayIdentityVerdict("subj:user-a");

        expect(judged.verdict).toBe("match");

        const credential = judged.verdict === "match" ? judged.credential : undefined;

        client.setAuthToken("token-b", "user-b");

        await client.mutation(fnRef("messages:send"), {}, { replayBaseline: null, replayCredential: credential });

        expect(bearers).toStrictEqual(["Bearer token-a"]);
        await expect(client.mutation(fnRef("messages:send"), {}, { replayBaseline: null, replayCredential: credential })).rejects.toThrow(TypeError);
        await expect(other.mutation(fnRef("messages:send"), {}, { replayBaseline: null, replayCredential: credential })).rejects.toThrow(TypeError);
        expect(fetchMock).toHaveBeenCalledTimes(1);

        client.close();
        other.close();
    });
});
