import { describe, expect, it, vi } from "vitest";

import { LunoraClient } from "../src/lunora-client";

// --- Test doubles -------------------------------------------------------------
// Minimal WebSocket stub: these tests only exercise `callMutator` (plain fetch)
// and `setAuthToken`, never a live socket, so no message/open plumbing is needed
// — just enough shape for the client's `options.WebSocket` typing.

class NoopWebSocket {
    public readonly url: string;

    public readyState = 0;

    public onopen: (() => void) | null = null;

    public onmessage: ((event: { data: unknown }) => void) | null = null;

    public onclose: (() => void) | null = null;

    public onerror: (() => void) | null = null;

    public constructor(url: string) {
        this.url = url;
    }

    // eslint-disable-next-line class-methods-use-this -- test double: the real WebSocket instance API, unused here
    public addEventListener(): void {}

    // eslint-disable-next-line class-methods-use-this -- test double: the real WebSocket instance API, unused here
    public send(): void {}

    // eslint-disable-next-line class-methods-use-this -- test double: the real WebSocket instance API, unused here
    public close(): void {}
}

const jsonResponse = (body: unknown): Response =>
    Response.json(body, {
        headers: { "content-type": "application/json" },
        status: 200,
    });

describe("lunoraClient — mutation watermark scoped by identity (plan 316)", () => {
    it("acks under identity A, drops under identity B, and recovers on switching back to A", async () => {
        expect.assertions(3);

        const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({ lastMutationId: 5, result: "ok" }));
        const client = new LunoraClient({
            fetch: fetchMock,
            url: "https://app.example",
            WebSocket: NoopWebSocket as unknown as typeof WebSocket,
        });

        client.setAuthToken("token-a", "user-a");
        await client.callMutator("messages:send", { text: "hi" }, { clientSeq: 5 });

        expect(client.confirmedMutationWatermark()).toBe(5);

        // Regression: a user switch must not let the new identity inherit — or
        // get wedged behind — the previous identity's watermark.
        client.setAuthToken("token-b", "user-b");

        expect(client.confirmedMutationWatermark()).toBe(0);

        // Switching back to A recovers A's watermark — the composite-key win a
        // bare `clientWatermarks.clear()` on identity change would lose.
        client.setAuthToken("token-a", "user-a");

        expect(client.confirmedMutationWatermark()).toBe(5);
    });

    it("does not reset the watermark on a same-token subject resolve", async () => {
        expect.assertions(2);

        const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({ lastMutationId: 7, result: "ok" }));
        const client = new LunoraClient({
            fetch: fetchMock,
            url: "https://app.example",
            WebSocket: NoopWebSocket as unknown as typeof WebSocket,
        });

        client.setAuthToken("token-a");
        await client.callMutator("messages:send", { text: "hi" }, { clientSeq: 7 });

        expect(client.confirmedMutationWatermark()).toBe(7);

        // Token unchanged, subject resolving late (contract §3.2) — must migrate
        // the cached watermark, not drop it.
        client.setAuthToken("token-a", "user-a");

        expect(client.confirmedMutationWatermark()).toBe(7);
    });

    it("debug() emits bare bucket keys and never another identity's watermark", async () => {
        expect.assertions(2);

        const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({ lastMutationId: 2, result: "ok" }));
        const client = new LunoraClient({
            fetch: fetchMock,
            url: "https://app.example",
            WebSocket: NoopWebSocket as unknown as typeof WebSocket,
        });

        client.setAuthToken("token-a", "user-a");
        await client.callMutator("messages:send", { text: "hi" }, { clientSeq: 2, shardKey: "room-1" });

        client.setAuthToken("token-b", "user-b");

        const { shards } = client.debug();

        expect(shards.every((shard) => !shard.shardKey?.includes("�"))).toBe(true);
        // User B must not see user A's still-cached watermark for "room-1".
        expect(shards.find((shard) => shard.shardKey === "room-1")?.confirmedMutationWatermark ?? 0).toBe(0);
    });
});
