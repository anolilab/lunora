/**
 * `LunoraClient.streamRpc` — the reader for a worker-served op that answers
 * Server-Sent Events instead of one JSON body (plan 364 W5).
 *
 * The property these assertions exist to pin is the asymmetry: intermediate
 * frames are narration a caller may ignore, and only the terminal frame is the
 * answer. That is what lets a consumer treat an interrupted call as having
 * produced nothing, which is the plan's gate — so the rejection on a body that
 * ends early matters more here than any of the happy paths.
 */
import { describe, expect, it, vi } from "vitest";

import { encodeWire } from "../../../shared/wire-codec";
import { LunoraClient } from "../src/lunora-client";
import type { FunctionReference } from "../src/types";

const CHAT = { __lunoraRef: "__lunora_admin__:aiChat" } satisfies FunctionReference;

/** Build an SSE response whose body delivers `parts` as separate reads, then closes. */
const sseResponse = (parts: string[]): Response => {
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
        start(controller) {
            for (const part of parts) {
                controller.enqueue(encoder.encode(part));
            }

            controller.close();
        },
    });

    return new Response(body, { headers: { "content-type": "text/event-stream; charset=utf-8" }, status: 200 });
};

/** Streams never open a socket; this stub only satisfies the option type. */
class NoopSocket {
    public readonly readyState = 0;
}

const client = (fetchImpl: typeof fetch): LunoraClient =>
    new LunoraClient({ fetch: fetchImpl, url: "https://app.example", WebSocket: NoopSocket as unknown as typeof WebSocket });

const frame = (payload: unknown): string => `data: ${JSON.stringify(payload)}\n\n`;

const terminal = (result: unknown): string => `event: complete\ndata: ${JSON.stringify({ result: encodeWire(result) })}\n\n`;

describe("lunoraClient.streamRpc", () => {
    it("reports every frame and resolves with the terminal one", async () => {
        expect.assertions(2);

        const fetchMock = vi.fn<typeof fetch>(async () =>
            sseResponse([frame({ text: "Two", type: "delta" }), frame({ text: " rows.", type: "delta" }), terminal({ degraded: false, reply: "Two rows." })]),
        );

        const seen: unknown[] = [];
        const result = await client(fetchMock).streamRpc(CHAT, { prompt: "how many?" }, { onFrame: (value) => seen.push(value) });

        expect(seen).toStrictEqual([
            { text: "Two", type: "delta" },
            { text: " rows.", type: "delta" },
        ]);
        expect(result).toStrictEqual({ degraded: false, reply: "Two rows." });
    });

    it("posts the ordinary RPC envelope with the bearer, on the ordinary RPC path", async () => {
        expect.assertions(4);

        const fetchMock = vi.fn<typeof fetch>(async () => sseResponse([terminal({ degraded: false })]));
        const withToken = client(fetchMock);

        withToken.setAuthToken("admin-token");
        await withToken.streamRpc(CHAT, { prompt: "hi" }, { shardKey: "channel:demo" });

        const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
        const sent = JSON.parse(init.body as string) as { args: Record<string, unknown>; functionPath: string; shardKey?: string };
        const headers = init.headers as Record<string, string>;

        // The same path and the same envelope as `query`: only the RESPONSE framing
        // differs, which is what keeps the admin gate and the reserved-op
        // interception exactly as they were.
        expect(url).toBe("https://app.example/_lunora/rpc");
        expect(sent).toMatchObject({ functionPath: "__lunora_admin__:aiChat", shardKey: "channel:demo" });
        expect(headers["authorization"]).toBe("Bearer admin-token");
        expect(headers["accept"]).toBe("text/event-stream");
    });

    it("rejects — committing nothing — when the body ends without a terminal frame", async () => {
        expect.assertions(2);

        // Plan 364's W5 gate. A dropped connection leaves deltas and no `complete`,
        // and resolving with what arrived is exactly how a half-answer would reach a
        // transcript. The caller must see a failure instead.
        const fetchMock = vi.fn<typeof fetch>(async () => sseResponse([frame({ text: "Two ro", type: "delta" })]));

        const seen: unknown[] = [];

        await expect(client(fetchMock).streamRpc(CHAT, { prompt: "how many?" }, { onFrame: (value) => seen.push(value) })).rejects.toThrow(
            /without a complete frame/u,
        );

        // The narration still arrived — it just was never an answer.
        expect(seen).toHaveLength(1);
    });

    it("surfaces an error frame as a coded rejection", async () => {
        expect.assertions(1);

        const fetchMock = vi.fn<typeof fetch>(async () =>
            sseResponse([`event: error\ndata: ${JSON.stringify({ code: "AI_CHAT_FAILED", message: "nope" })}\n\n`]),
        );

        await expect(client(fetchMock).streamRpc(CHAT, {})).rejects.toMatchObject({ code: "AI_CHAT_FAILED" });
    });

    it("surfaces a refused request as the coded error its JSON envelope describes", async () => {
        expect.assertions(1);

        // An admin refusal must read the same on this transport as on `query` —
        // the gate answers before any stream is constructed, so the body is JSON.
        const fetchMock = vi.fn<typeof fetch>(async () =>
            Response.json({ error: { code: "ADMIN_FORBIDDEN", message: "admin token required" } }, { status: 403 }),
        );

        await expect(client(fetchMock).streamRpc(CHAT, {})).rejects.toMatchObject({ code: "ADMIN_FORBIDDEN" });
    });

    it("decodes the terminal frame through the wire codec", async () => {
        expect.assertions(1);

        // The terminal frame carries the same `{ result: encodeWire(...) }` envelope
        // every other worker-served op answers with, so a bigint survives a streamed
        // result exactly as it survives a whole one.
        const fetchMock = vi.fn<typeof fetch>(async () => sseResponse([terminal({ rows: 42n })]));

        await expect(client(fetchMock).streamRpc(CHAT, {})).resolves.toStrictEqual({ rows: 42n });
    });
});
