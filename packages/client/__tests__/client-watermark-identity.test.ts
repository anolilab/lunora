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

    it("merges a same-token subject resolve INTO an identity that already has cached watermarks, without clobbering either bucket", async () => {
        expect.assertions(2);

        // Nested-map restampWatermarks branches on whether the TARGET identity
        // already holds a bucket map: the old flat composite-key scheme never
        // had this branch (a plain Map.set() always just overwrote). Reach it
        // with: (1) populate "subj:user-a" directly, (2) a REAL credential
        // change (different token + subject) to "subj:user-x" — tokenChanged
        // is true, so setAuthToken takes the reject-queued-writes branch, NOT
        // restamp, leaving "subj:user-a"'s cached bucket untouched but
        // inactive, (3) populate "subj:user-x" directly, (4) a same-token
        // subject change BACK to "user-a" — tokenChanged is now false, so THIS
        // one takes the restamp branch, targeting "subj:user-a" while it still
        // holds its step-1 data — the merge.
        const fetchMock = vi
            .fn<typeof fetch>()
            .mockResolvedValueOnce(jsonResponse({ lastMutationId: 1, result: "ok" }))
            .mockResolvedValueOnce(jsonResponse({ lastMutationId: 5, result: "ok" }));
        const client = new LunoraClient({
            fetch: fetchMock,
            url: "https://app.example",
            WebSocket: NoopWebSocket as unknown as typeof WebSocket,
        });

        // (1) Pre-populate "subj:user-a" with its own bucket.
        client.setAuthToken("token-a", "user-a");
        await client.callMutator("messages:send", { text: "hi" }, { clientSeq: 1, shardKey: "explicit-bucket" });

        expect(client.confirmedMutationWatermark("explicit-bucket")).toBe(1);

        // (2)+(3) A real credential change (new token AND subject) — leaves
        // "subj:user-a"'s cache alone (see comment above) — then populate the
        // new identity's own bucket.
        client.setAuthToken("token-b", "user-x");
        await client.callMutator("messages:send", { text: "hi" }, { clientSeq: 5, shardKey: "new-bucket" });

        // (4) Same token as the call above, subject resolves back to "user-a",
        // which still has its step-1 watermark cached — the merge branch.
        client.setAuthToken("token-b", "user-a");

        // Both buckets survive under "subj:user-a": the pre-existing one
        // (untouched) and the restamped one (merged in, not clobbered).
        expect([client.confirmedMutationWatermark("explicit-bucket"), client.confirmedMutationWatermark("new-bucket")]).toStrictEqual([1, 5]);
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

    it("does not mix watermarks when the separator character appears in an identity and, separately, in a bucket (PR review)", async () => {
        expect.assertions(2);

        // The separator {@link clientWatermarks} used to join identity+bucket
        // into one string key. Both operands are arbitrary strings (a subject
        // supplied to `setAuthToken`; a shard key), so the SAME separator can
        // appear in either one — these two pairs joined to the identical
        // string under that scheme: `subj:a<SEP>x` + bucket `y`, and
        // `subj:a` + bucket `x<SEP>y`.
        const SEP = String.fromCodePoint(0xff_fd);
        const identityWithSepSubject = `a${SEP}x`;
        const bucketWithSep = `x${SEP}y`;

        const fetchMock = vi
            .fn<typeof fetch>()
            .mockResolvedValueOnce(jsonResponse({ lastMutationId: 3, result: "ok" }))
            .mockResolvedValueOnce(jsonResponse({ lastMutationId: 9, result: "ok" }));
        const client = new LunoraClient({
            fetch: fetchMock,
            url: "https://app.example",
            WebSocket: NoopWebSocket as unknown as typeof WebSocket,
        });

        // Identity A: subject carries the separator; bucket does not.
        client.setAuthToken("token-a", identityWithSepSubject);
        await client.callMutator("messages:send", { text: "hi" }, { clientSeq: 3, shardKey: "y" });

        expect(client.confirmedMutationWatermark("y")).toBe(3);

        // Identity B: plain subject; the separator is in the BUCKET instead.
        // Under the old joined-string scheme this collides with identity A's
        // key above and would clobber/inherit its watermark.
        client.setAuthToken("token-b", "a");
        await client.callMutator("messages:send", { text: "hi" }, { clientSeq: 9, shardKey: bucketWithSep });

        // B's write under the colliding bucket must not have touched A's
        // separately-cached watermark for plain bucket "y".
        client.setAuthToken("token-a", identityWithSepSubject);

        expect(client.confirmedMutationWatermark("y")).toBe(3);
    });

    it("files the ack under the identity that issued the call, not the identity active when it resolves (PR review)", async () => {
        expect.assertions(2);

        let resolveFetch!: (response: Response) => void;
        const fetchMock = vi.fn<typeof fetch>(
            () =>
                new Promise((resolve) => {
                    resolveFetch = resolve;
                }),
        );

        const client = new LunoraClient({
            fetch: fetchMock,
            url: "https://app.example",
            WebSocket: NoopWebSocket as unknown as typeof WebSocket,
        });

        client.setAuthToken("token-a", "user-a");

        // Issued as A, but its RPC is deliberately left hanging.
        const pending = client.callMutator("messages:send", { text: "hi" }, { clientSeq: 6 });

        // Switch to B WHILE A's call above is still in flight.
        client.setAuthToken("token-b", "user-b");

        resolveFetch(jsonResponse({ lastMutationId: 6, result: "ok" }));
        await pending;

        // The ack belongs to A, who issued the call — not B, who was active
        // when the response happened to land.
        client.setAuthToken("token-a", "user-a");

        expect(client.confirmedMutationWatermark()).toBe(6);

        client.setAuthToken("token-b", "user-b");

        expect(client.confirmedMutationWatermark()).toBe(0);
    });
});
