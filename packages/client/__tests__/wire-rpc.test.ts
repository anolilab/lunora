import { describe, expect, it, vi } from "vitest";

import { encodeWire } from "../../../shared/wire-codec";
import { LunoraClient } from "../src/lunora-client";
import type { FunctionReference } from "../src/types";

const fnRef = (ref: string): FunctionReference => {
    return { __lunoraRef: ref };
};

const jsonResponse = (body: unknown, init: ResponseInit = {}): Response =>
    Response.json(body, { headers: { "content-type": "application/json" }, status: 200, ...init });

// RPC-only tests never open a socket; this stub just satisfies the option type.
class NoopSocket {
    public readonly readyState = 0;
}

const client = (fetchImpl: typeof fetch): LunoraClient =>
    new LunoraClient({ fetch: fetchImpl, url: "https://app.example", WebSocket: NoopSocket as unknown as typeof WebSocket });

const TAG = "$lunora.wire$";

describe("rpc wire codec (086)", () => {
    it("encodes bigint / ArrayBuffer args onto the wire (JSON would drop or throw)", async () => {
        expect.assertions(2);

        const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({ result: null }));

        await client(fetchMock).query(fnRef("docs:get"), { n: 7n, buf: new Uint8Array([1, 2, 3]).buffer });

        const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
        const sent = JSON.parse(init.body as string) as { args: Record<string, unknown> };

        expect(sent.args.n).toStrictEqual([TAG, "bigint", "7"]);
        expect((sent.args.buf as unknown[])[1]).toBe("bytes");
    });

    it("decodes a bigint / ArrayBuffer result back to real values", async () => {
        expect.assertions(2);

        // The server (DO) encodes its result; the mock returns the wire form.
        const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({ result: encodeWire({ total: 42n, blob: new Uint8Array([9, 8]).buffer }) }));

        const value = (await client(fetchMock).query(fnRef("docs:stats"), {})) as { blob: ArrayBuffer; total: bigint };

        expect(value.total).toBe(42n);
        expect([...new Uint8Array(value.blob)]).toStrictEqual([9, 8]);
    });
});

describe("structured error propagation (087)", () => {
    it("reconstructs an app error's code and wire-decoded data", async () => {
        expect.assertions(2);

        const fetchMock = vi.fn<typeof fetch>(async () =>
            jsonResponse(
                { error: { code: "TOO_MANY_REQUESTS", data: encodeWire({ retryAfterMs: 3000, quota: 100n }), message: "slow down" } },
                { status: 429 },
            ),
        );

        const error = (await client(fetchMock)
            .mutation(fnRef("docs:write"), {})
            .catch((error_: unknown) => error_)) as { code?: string; data?: { quota: bigint; retryAfterMs: number } };

        expect(error.code).toBe("TOO_MANY_REQUESTS");
        expect(error.data).toStrictEqual({ retryAfterMs: 3000, quota: 100n });
    });

    it("leaves a plain redacted error (no data) as a bare coded Error", async () => {
        expect.assertions(2);

        const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({ error: { code: "RPC_FAILED", message: "internal error" } }, { status: 500 }));

        const error = (await client(fetchMock)
            .query(fnRef("docs:get"), {})
            .catch((error_: unknown) => error_)) as { code?: string; data?: unknown };

        expect(error.code).toBe("RPC_FAILED");
        expect(error.data).toBeUndefined();
    });
});
