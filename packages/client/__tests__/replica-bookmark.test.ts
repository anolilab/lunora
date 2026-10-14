import { describe, expect, it, vi } from "vitest";

import { LunoraClient } from "../src/lunora-client";
import type { FunctionReference } from "../src/types";

/**
 * Read-your-writes across region-local read replicas.
 *
 * The server echoes the CDC cursor a write committed at (`commitCursor`); this
 * client remembers it per shard and sends it back as `x-lunora-min-seq`, which
 * is what stops a replica from answering a later read from a copy that predates
 * that write. Everything here is inert on a deployment with `replicaReads` off —
 * the header is simply ignored.
 */

const fnRef = (ref: string): FunctionReference => {
    return { __lunoraRef: ref };
};

class NoopSocket {
    public readonly readyState = 0;
}

const client = (fetchImpl: typeof fetch): LunoraClient =>
    new LunoraClient({ fetch: fetchImpl, url: "https://app.example", WebSocket: NoopSocket as unknown as typeof WebSocket });

/** The `x-lunora-min-seq` header on the nth captured request, or `undefined` when absent. */
const minSeqOf = (fetchMock: ReturnType<typeof vi.fn<typeof fetch>>, index: number): string | undefined => {
    const [, init] = fetchMock.mock.calls[index] as unknown as [string, RequestInit];

    return (init.headers as Record<string, string>)["x-lunora-min-seq"];
};

describe("replica read-your-writes bookmark", () => {
    it("sends no bookmark before the client has written anything", async () => {
        expect.assertions(1);

        const fetchMock = vi.fn<typeof fetch>(async () => Response.json({ result: [] }));

        await client(fetchMock).query(fnRef("posts:list"), {});

        // Nothing to require yet — the read may be served from any replica
        // inside the staleness window.
        expect(minSeqOf(fetchMock, 0)).toBeUndefined();
    });

    it("requires at least the cursor its own write committed at", async () => {
        expect.assertions(2);

        const fetchMock = vi.fn<typeof fetch>(async () => Response.json({ commitCursor: 17, result: null }));
        const instance = client(fetchMock);

        await instance.mutation(fnRef("posts:add"), { title: "hi" });

        expect(minSeqOf(fetchMock, 0)).toBeUndefined();

        await instance.query(fnRef("posts:list"), {});

        expect(minSeqOf(fetchMock, 1)).toBe("17");
    });

    it("never moves the requirement backwards", async () => {
        expect.assertions(1);

        // Responses can land out of order; taking the lower cursor would let a
        // read be answered from a copy predating a write this client has seen.
        const cursors = [30, 12];
        const fetchMock = vi.fn<typeof fetch>(async () => Response.json({ commitCursor: cursors.shift(), result: null }));
        const instance = client(fetchMock);

        await instance.mutation(fnRef("posts:add"), {});
        await instance.mutation(fnRef("posts:add"), {});
        await instance.query(fnRef("posts:list"), {});

        expect(minSeqOf(fetchMock, 2)).toBe("30");
    });

    it("treats an implicit shard and the server's default-shard name as one shard", async () => {
        expect.assertions(2);

        // Only the server knows that omitting `shardKey` and naming its
        // configured default are the same shard, so it says which key it
        // resolved. Without that, one shard's cursor splits across two client
        // entries and a write under one spelling stops constraining a read under
        // the other.
        const fetchMock = vi.fn<typeof fetch>(async () => Response.json({ commitCursor: 21, result: null }, { headers: { "x-lunora-shard-key": "__root__" } }));
        const instance = client(fetchMock);

        // Write with no shard key at all; the response names the shard.
        await instance.mutation(fnRef("posts:add"), {});

        // Read naming that same shard explicitly — the requirement must carry.
        await instance.query(fnRef("posts:list"), {}, { shardKey: "__root__" });

        expect(minSeqOf(fetchMock, 1)).toBe("21");

        // …and the other way around, from the explicit name back to the implicit call.
        await instance.query(fnRef("posts:list"), {});

        expect(minSeqOf(fetchMock, 2)).toBe("21");
    });

    it("keeps the cursor per shard", async () => {
        expect.assertions(2);

        const fetchMock = vi.fn<typeof fetch>(async () => Response.json({ commitCursor: 9, result: null }));
        const instance = client(fetchMock);

        await instance.mutation(fnRef("posts:add"), {}, { shardKey: "tenant-a" });
        await instance.query(fnRef("posts:list"), {}, { shardKey: "tenant-a" });

        expect(minSeqOf(fetchMock, 1)).toBe("9");

        // A different shard has its own timeline; requiring tenant-a's cursor
        // there would demand a position that shard's log may never reach.
        await instance.query(fnRef("posts:list"), {}, { shardKey: "tenant-b" });

        expect(minSeqOf(fetchMock, 2)).toBeUndefined();
    });
});
