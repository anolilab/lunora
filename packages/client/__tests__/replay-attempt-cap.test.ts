import { afterEach, describe, expect, it, vi } from "vitest";

import { LunoraClient } from "../src/lunora-client";
import { createInMemoryPersistence } from "../src/persistence";
import { createSocketHarness, fnRef, jsonResponse, settle } from "./lib/harness";

// What a handler that always throws reaches the client as: the shard's `{ error }` envelope, coded with the thrown
// error's own code (or `RPC_FAILED` for a bare throw). Never a transient code, so it is a verdict on the write.
const handlerFailure = (): Response => jsonResponse({ error: { code: "RPC_FAILED", message: "internal error" } }, { status: 500 });

const createClient = (fetchImpl: typeof fetch) => {
    const { sockets, WebSocket } = createSocketHarness();
    const client = new LunoraClient({
        fetch: fetchImpl,
        heartbeatIntervalMs: 0,
        offlineQueue: { queueBeforeFirstConnect: true },
        persistence: createInMemoryPersistence(),
        url: "http://app.test",
        WebSocket,
    });

    client.subscribe(fnRef("todos.list"), {}, () => undefined);

    return { client, sockets };
};

describe("replay of a write the shard keeps failing", () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it("settles a write whose handler always throws on its first attempt", async () => {
        expect.assertions(3);

        vi.useFakeTimers();

        const fetchImpl = vi.fn<typeof fetch>(async () => handlerFailure());
        const { client, sockets } = createClient(fetchImpl);
        const write = client.mutation(fnRef("todos.set"), { text: "poison" });
        const outcome = write.then(
            () => "resolved",
            (error: unknown) => (error as { code?: string }).code,
        );

        await settle();
        sockets[0]?.open();
        await vi.advanceTimersByTimeAsync(5000);

        await expect(outcome).resolves.toBe("RPC_FAILED");
        expect(fetchImpl).toHaveBeenCalledTimes(1);
        expect(client.pendingCount()).toBe(0);

        client.close();
    });

    it("does not let a write whose handler always throws block the siblings queued with it", async () => {
        expect.assertions(3);

        vi.useFakeTimers();

        const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
            const body = JSON.parse(init?.body as string) as { args?: { text?: string }; calls?: { args: { text: string } }[] };
            const calls = body.calls ?? [{ args: body.args as { text: string } }];

            if (body.calls) {
                return jsonResponse({
                    results: calls.map((call, id) =>
                        call.args.text === "poison"
                            ? { body: { error: { code: "RPC_FAILED", message: "internal error" } }, id }
                            : { body: { result: { ok: true } }, id },
                    ),
                });
            }

            return calls[0]?.args.text === "poison" ? handlerFailure() : jsonResponse({ result: { ok: true } });
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
        await expect(poison).resolves.toBe("RPC_FAILED");
        expect(client.pendingCount()).toBe(0);

        client.close();
    });

    it("keeps retrying a write after a transport failure, however many there are", async () => {
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
    // out) per slot. That is not a verdict on the write, so it is retried rather than settled.
    it("keeps retrying a write after a shard-level SHARD_UNAVAILABLE, however many there are", async () => {
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

        await expect(write).resolves.toStrictEqual({ ok: true });
        expect(fetchImpl).toHaveBeenCalledTimes(6);

        client.close();
    });
});
