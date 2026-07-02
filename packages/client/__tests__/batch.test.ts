import { describe, expect, it, vi } from "vitest";

import { encodeWire } from "../../../shared/wire-codec";
import { LunoraClient } from "../src/lunora-client";
import type { FunctionReference } from "../src/types";

const fnRef = (ref: string): FunctionReference => {
    return { __lunoraRef: ref };
};

const jsonResponse = (body: unknown, init: ResponseInit = {}): Response =>
    Response.json(body, { headers: { "content-type": "application/json" }, status: 200, ...init });

class NoopSocket {
    public readonly readyState = 0;
}

const client = (fetchImpl: typeof fetch): LunoraClient =>
    new LunoraClient({ fetch: fetchImpl, url: "https://app.example", WebSocket: NoopSocket as unknown as typeof WebSocket });

describe("client batch transport (088)", () => {
    it("posts one /_lunora/rpc-batch request with id-tagged, wire-encoded calls", async () => {
        expect.assertions(3);

        const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({ results: [] }));

        await client(fetchMock).batch([
            { args: { n: 5n }, fn: fnRef("docs:a") },
            { args: {}, fn: fnRef("docs:b"), shardKey: "tenant_1" },
        ]);

        const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
        const sent = JSON.parse(init.body as string) as { calls: { args: unknown; functionPath: string; id: number; shardKey?: string }[] };

        expect(url).toBe("https://app.example/_lunora/rpc-batch");
        expect(sent.calls.map((c) => [c.id, c.functionPath, c.shardKey])).toStrictEqual([
            [0, "docs:a", undefined],
            [1, "docs:b", "tenant_1"],
        ]);
        // bigint arg rode the wire codec
        expect((sent.calls[0] as { args: { n: unknown } }).args.n).toStrictEqual(["$lunora.wire$", "bigint", "5"]);
    });

    it("demuxes per-slot results, decoding values and reconstructing error code/data", async () => {
        expect.assertions(4);

        const fetchMock = vi.fn<typeof fetch>(async () =>
            jsonResponse({
                results: [
                    { body: { result: encodeWire({ total: 42n }) }, id: 0, status: 200 },
                    { body: { error: { code: "CONFLICT", data: encodeWire({ retryAfterMs: 100 }), message: "nope" } }, id: 1, status: 409 },
                ],
            }),
        );

        const slots = await client(fetchMock).batch([{ fn: fnRef("docs:read") }, { fn: fnRef("docs:write") }]);

        expect(slots[0]).toStrictEqual({ ok: true, value: { total: 42n } });
        expect(slots[1]?.ok).toBe(false);

        const failed = slots[1] as { error: Error & { code?: string; data?: unknown }; ok: false };

        expect(failed.error.code).toBe("CONFLICT");
        expect(failed.error.data).toStrictEqual({ retryAfterMs: 100 });
    });

    it("surfaces a server-dropped slot as an error rather than a silent undefined", async () => {
        expect.assertions(2);

        // Two calls requested, server returns only slot 0.
        const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({ results: [{ body: { result: null }, id: 0, status: 200 }] }));

        const slots = await client(fetchMock).batch([{ fn: fnRef("docs:a") }, { fn: fnRef("docs:b") }]);

        expect(slots[0]).toStrictEqual({ ok: true, value: null });
        expect(slots[1]?.ok).toBe(false);
    });

    it("rejects the whole batch (not per-slot) when the worker returns a batch-level error", async () => {
        expect.assertions(2);

        // A per-entry authorization denial fails the batch closed before dispatch:
        // non-2xx + { error }, no results. The caller must see the real code, not
        // an opaque "no result" on every slot.
        const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({ error: { code: "FORBIDDEN", message: "denied" } }, { status: 403 }));

        const error = (await client(fetchMock)
            .batch([{ fn: fnRef("docs:a") }])
            .catch((error_: unknown) => error_)) as { code?: string };

        expect(error).toBeInstanceOf(Error);
        expect(error.code).toBe("FORBIDDEN");
    });
});
