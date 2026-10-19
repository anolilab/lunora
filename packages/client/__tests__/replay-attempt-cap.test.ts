import { afterEach, describe, expect, it, vi } from "vitest";

import { LunoraClient } from "../src/lunora-client";
import { createInMemoryPersistence } from "../src/persistence";
import { createSocketHarness, fnRef, jsonResponse, settle } from "./lib/harness";

const shardError = (): Response => jsonResponse({ error: { code: "SHARD_ERROR", message: "shard answered garbage" } }, { status: 500 });

const replayRetry = { maxShardErrorAttempts: 3 };

const createClient = (fetchImpl: typeof fetch) => {
    const { sockets, WebSocket } = createSocketHarness();
    const client = new LunoraClient({
        fetch: fetchImpl,
        heartbeatIntervalMs: 0,
        offlineQueue: { queueBeforeFirstConnect: true, replayRetry },
        persistence: createInMemoryPersistence(),
        url: "http://app.test",
        WebSocket,
    });

    client.subscribe(fnRef("todos.list"), {}, () => undefined);

    return { client, sockets };
};

describe("replay attempt cap", () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it("settles a write the shard keeps failing on, after the configured number of attempts", async () => {
        expect.assertions(3);

        vi.useFakeTimers();

        const fetchImpl = vi.fn<typeof fetch>(async () => shardError());
        const { client, sockets } = createClient(fetchImpl);
        const write = client.mutation(fnRef("todos.set"), { text: "poison" });
        const outcome = write.then(
            () => "resolved",
            (error: unknown) => (error as { code?: string }).code,
        );

        await settle();
        sockets[0]?.open();
        await vi.advanceTimersByTimeAsync(5000);

        await expect(outcome).resolves.toBe("SHARD_ERROR");
        expect(fetchImpl).toHaveBeenCalledTimes(3);
        expect(client.pendingCount()).toBe(0);

        client.close();
    });

    it("does not let a poisoned write block the siblings queued behind it", async () => {
        expect.assertions(3);

        vi.useFakeTimers();

        const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
            const body = JSON.parse(init?.body as string) as { args?: { text?: string }; calls?: { args: { text: string } }[] };
            const calls = body.calls ?? [{ args: body.args as { text: string } }];

            if (body.calls) {
                return jsonResponse({
                    results: calls.map((call, id) =>
                        call.args.text === "poison"
                            ? { body: { error: { code: "SHARD_ERROR", message: "shard answered garbage" } }, id }
                            : { body: { result: { ok: true } }, id },
                    ),
                });
            }

            return calls[0]?.args.text === "poison" ? shardError() : jsonResponse({ result: { ok: true } });
        });
        const { client, sockets } = createClient(fetchImpl);
        const poison = client.mutation(fnRef("todos.set"), { text: "poison" }).then(
            () => "resolved",
            (error: unknown) => (error as { code?: string }).code,
        );
        const sibling = client.mutation(fnRef("todos.set"), { text: "fine" });

        await settle();
        sockets[0]?.open();
        await vi.advanceTimersByTimeAsync(5000);

        await expect(sibling).resolves.toStrictEqual({ ok: true });
        await expect(poison).resolves.toBe("SHARD_ERROR");
        expect(client.pendingCount()).toBe(0);

        client.close();
    });

    it("never counts a transport failure against the cap", async () => {
        expect.assertions(2);

        vi.useFakeTimers();

        let calls = 0;
        const fetchImpl = vi.fn<typeof fetch>(async () => {
            calls += 1;

            return calls <= 5 ? new Response("<html>bad gateway</html>", { status: 502 }) : jsonResponse({ result: { ok: true } });
        });
        const { client, sockets } = createClient(fetchImpl);
        const write = client.mutation(fnRef("todos.set"), { text: "slow-link" });

        await settle();
        sockets[0]?.open();
        await vi.advanceTimersByTimeAsync(40_000);

        await expect(write).resolves.toStrictEqual({ ok: true });
        expect(fetchImpl).toHaveBeenCalledTimes(6);

        client.close();
    });

    // The worker reports a shard that could not answer a batch at all (non-JSON reply, results left
    // out) per slot. That is not a verdict on the write, so it must never spend the write's cap.
    it("never counts a shard-level SHARD_UNAVAILABLE against the cap", async () => {
        expect.assertions(2);

        vi.useFakeTimers();

        let calls = 0;
        const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
            calls += 1;

            const body = JSON.parse(init?.body as string) as { calls?: unknown[] };
            const unavailable = { error: { code: "SHARD_UNAVAILABLE", message: "shard batch omitted result" } };

            if (calls > 5) {
                return body.calls ? jsonResponse({ results: [{ body: { result: { ok: true } }, id: 0 }] }) : jsonResponse({ result: { ok: true } });
            }

            return body.calls ? jsonResponse({ results: [{ body: unavailable, id: 0 }] }) : jsonResponse(unavailable, { status: 503 });
        });
        const { client, sockets } = createClient(fetchImpl);
        const write = client.mutation(fnRef("todos.set"), { text: "kept" });

        await settle();
        sockets[0]?.open();
        await vi.advanceTimersByTimeAsync(40_000);

        // Five refusals is past the cap of 3: only the code decides whether they count.
        await expect(write).resolves.toStrictEqual({ ok: true });
        expect(fetchImpl).toHaveBeenCalledTimes(6);

        client.close();
    });
});
