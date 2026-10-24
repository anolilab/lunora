import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createFunctionMcpServer } from "../src/function-server";
import { serveStateless } from "../src/serve-stateless";
import method from "./_helpers/openrpc";

/**
 * A stream is read over the Lunora WebSocket (`client.stream`), not `fetch`. These
 * tests stub the global `WebSocket` with a double that replays the frames the server
 * sends for a stream (`ack`, `chunk`, `complete`, `error`, see `ServerMessage` in
 * `@lunora/client`'s types) and records the frames the client sends. The client itself
 * is real, so the stream goes through `client.stream`'s own parsing and cancel path.
 */

type Frame = Record<string, unknown>;

/** What the double does when a `stream` frame arrives: the frames it answers with, in order. */
type Script = (streamId: string) => Frame[];

const streamFrames: { script: Script } = { script: () => [] };

/** A WebSocket double. It opens on the next microtask, answers `stream` frames with `streamFrames.script`, and records what the client sent. */
class StreamSocket {
    public static readonly sent: Frame[] = [];

    /** The socket most recently opened, so a test can deliver a frame to a stream that is still open. */
    public static readonly live: { socket?: StreamSocket } = {};

    /** Resolvers waiting for a frame of a given type to be sent. A milestone, so a test never polls. */
    private static readonly waiters: { resolve: () => void; type: string }[] = [];

    /** Resolves once the client has sent a frame of `type`. */
    public static whenSent(type: string): Promise<void> {
        return new Promise<void>((resolve) => {
            if (StreamSocket.sent.some((frame) => frame["type"] === type)) {
                resolve();

                return;
            }

            StreamSocket.waiters.push({ resolve, type });
        });
    }

    /** Delivers a server frame to the most recently opened socket, as the server would once a stream has more to say. */
    public static deliver(reply: Frame): void {
        StreamSocket.live.socket?.dispatch("message", { data: JSON.stringify(reply) });
    }

    public readonly url: string;

    private readonly listeners = new Map<string, ((event: unknown) => void)[]>();

    public constructor(url: string) {
        this.url = url;
        StreamSocket.live.socket = this;
        queueMicrotask(() => {
            this.dispatch("open", {});
        });
    }

    public addEventListener(type: string, listener: (event: unknown) => void): void {
        this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
    }

    public close(): void {
        this.dispatch("close", { code: 1000, reason: "" });
    }

    public send(payload: string): void {
        const frame = JSON.parse(payload) as Frame;

        StreamSocket.sent.push(frame);

        for (const waiter of StreamSocket.waiters.filter((candidate) => candidate.type === frame["type"])) {
            waiter.resolve();
        }

        if (frame["type"] === "stream") {
            const id = String(frame["id"]);

            queueMicrotask(() => {
                for (const reply of streamFrames.script(id)) {
                    this.dispatch("message", { data: JSON.stringify(reply) });
                }
            });
        }
    }

    private dispatch(type: string, event: unknown): void {
        for (const listener of this.listeners.get(type) ?? []) {
            listener(event);
        }
    }
}

const SPEC = {
    methods: [
        method("feed:tail", "stream", { args: { room: { type: "string" } }, argsRequired: true }),
        method("messages:list", "query", { args: {}, argsRequired: false }),
    ],
    openrpc: "1.3.2",
};

const CHUNKS = [{ n: 1 }, { n: 2 }, { n: 3 }];

/** Connect a real SDK client to the server, as a session does: one `listTools` primes the tool list. */
const connected = async (server: Server): Promise<Client> => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    await server.connect(serverTransport);

    const client = new Client({ name: "function-server-stream-test", version: "1.0.0" });

    await client.connect(clientTransport);
    await client.listTools();

    return client;
};

const CALLER_TOKEN = "caller-token";

const serverFor = (token?: string): Server =>
    createFunctionMcpServer({ fetch: vi.fn<typeof fetch>(), openRpcSpec: SPEC, url: "https://app.example", ...(token === undefined ? {} : { token }) });

/** The text block of a tool result, parsed. A stream returns its chunks here, not as structured content. */
const chunksOf = (content: unknown): unknown => JSON.parse((content as { text: string }[])[0]!.text) as unknown;

/** Each test stubs its own socket and frame script, so nothing carries over between them. */
const resetStreamDouble = (): void => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    StreamSocket.sent.length = 0;
    streamFrames.script = () => [];
};

describe("a stream tool over a real SDK client", () => {
    afterEach(resetStreamDouble);

    it("lists the stream as a read-only tool with no outputSchema", async () => {
        expect.assertions(3);

        vi.stubGlobal("WebSocket", StreamSocket);

        const client = await connected(serverFor());
        const { tools } = await client.listTools();
        const tail = tools.find((tool) => tool.name === "feed_tail");

        expect(tail).toBeDefined();
        expect(tail).not.toHaveProperty("outputSchema");
        expect(tail?.annotations?.readOnlyHint).toBe(true);

        await client.close();
    });

    it("authenticates the stream's socket with the caller's token, in its connect frame", async () => {
        expect.assertions(1);

        vi.stubGlobal("WebSocket", StreamSocket);
        streamFrames.script = (id) => [
            { id, type: "ack" },
            { id, type: "complete" },
        ];

        const client = await connected(serverFor(CALLER_TOKEN));

        await client.callTool({ arguments: { args: { room: "r1" } }, name: "feed_tail" });

        expect(StreamSocket.sent.find((frame) => frame["type"] === "connect")).toMatchObject({ token: CALLER_TOKEN });

        await client.close();
    });

    it("reports each chunk as progress, in order, with its JSON text, and returns every chunk", async () => {
        expect.assertions(5);

        vi.stubGlobal("WebSocket", StreamSocket);
        streamFrames.script = (id) => [
            { id, type: "ack" },
            ...CHUNKS.map((data) => {
                return { data, id, type: "chunk" };
            }),
            { id, type: "complete" },
        ];

        const client = await connected(serverFor());
        const onprogress = vi.fn<(progress: unknown) => void>();
        const result = await client.callTool({ arguments: { args: { room: "r1" } }, name: "feed_tail" }, undefined, { onprogress });

        expect(onprogress.mock.calls.map(([progress]) => (progress as { progress: number }).progress)).toStrictEqual([0, 1, 2]);
        expect(onprogress.mock.calls.map(([progress]) => (progress as { message: string }).message)).toStrictEqual(
            CHUNKS.map((chunk) => JSON.stringify(chunk)),
        );
        expect(result.isError ?? false).toBe(false);
        expect(chunksOf(result.content)).toStrictEqual(CHUNKS);
        expect(StreamSocket.sent.find((frame) => frame["type"] === "stream")).toMatchObject({
            query: { args: { room: "r1" }, functionPath: "feed:tail" },
        });

        await client.close();
    });

    it("returns a fast stream longer than the client's default buffer, with progress on", async () => {
        expect.assertions(2);

        // Above the client's 1,024-chunk default buffer and below the tool's 10,000-chunk cap.
        const many = Array.from({ length: 2000 }, (_, index) => {
            return { n: index };
        });

        vi.stubGlobal("WebSocket", StreamSocket);
        streamFrames.script = (id) => [
            { id, type: "ack" },
            ...many.map((data) => {
                return { data, id, type: "chunk" };
            }),
            { id, type: "complete" },
        ];

        const client = await connected(serverFor());
        const result = await client.callTool({ arguments: { args: { room: "r1" } }, name: "feed_tail" }, undefined, { onprogress: () => undefined });

        expect(result.isError ?? false).toBe(false);
        expect(chunksOf(result.content)).toHaveLength(2000);

        await client.close();
    });

    it("keeps an undefined chunk as null in the result, and keeps collecting after it", async () => {
        expect.assertions(2);

        vi.stubGlobal("WebSocket", StreamSocket);
        streamFrames.script = (id) => [
            { id, type: "ack" },
            { id, type: "chunk" },
            { data: CHUNKS[0], id, type: "chunk" },
            { id, type: "complete" },
        ];

        const client = await connected(serverFor());
        const result = await client.callTool({ arguments: { args: { room: "r1" } }, name: "feed_tail" }, undefined, { onprogress: () => undefined });

        expect(result.isError ?? false).toBe(false);
        expect(chunksOf(result.content)).toStrictEqual([null, CHUNKS[0]]);

        await client.close();
    });

    it("refuses a stream whose chunks add up to more than the byte budget, and cancels it", async () => {
        expect.assertions(2);

        // One chunk of 17 MiB of text: the count is 1, so only the size can refuse it.
        const huge = { text: "x".repeat(17 * 1024 * 1024) };

        vi.stubGlobal("WebSocket", StreamSocket);
        streamFrames.script = (id) => [
            { id, type: "ack" },
            { data: huge, id, type: "chunk" },
            { id, type: "complete" },
        ];

        const client = await connected(serverFor());
        const result = await client.callTool({ arguments: { args: { room: "r1" } }, name: "feed_tail" }, undefined, { onprogress: () => undefined });

        expect(result.structuredContent).toMatchObject({ code: "PAYLOAD_TOO_LARGE" });
        expect(result.isError).toBe(true);

        await client.close();
    });

    it("opens a stream with the WebSocket it was given when the runtime has no global one", async () => {
        expect.assertions(2);

        vi.stubGlobal("WebSocket", undefined);
        streamFrames.script = (id) => [
            { id, type: "ack" },
            { data: CHUNKS[0], id, type: "chunk" },
            { id, type: "complete" },
        ];

        const server = createFunctionMcpServer({
            fetch: vi.fn<typeof fetch>(),
            openRpcSpec: SPEC,
            url: "https://app.example",
            WebSocket: StreamSocket as unknown as typeof WebSocket,
        });
        const client = await connected(server);
        const result = await client.callTool({ arguments: { args: { room: "r1" } }, name: "feed_tail" });

        expect(result.isError ?? false).toBe(false);
        expect(chunksOf(result.content)).toStrictEqual([CHUNKS[0]]);

        await client.close();
    });

    it("delivers a mid-stream error as an error result, after the progress it already sent", async () => {
        expect.assertions(3);

        vi.stubGlobal("WebSocket", StreamSocket);
        streamFrames.script = (id) => [
            { id, type: "ack" },
            { data: CHUNKS[0], id, type: "chunk" },
            { error: { code: "FORBIDDEN", message: "no access to this room" }, id, type: "error" },
        ];

        const client = await connected(serverFor());
        const onprogress = vi.fn<(progress: unknown) => void>();
        const result = await client.callTool({ arguments: { args: { room: "r1" } }, name: "feed_tail" }, undefined, { onprogress });

        expect(result.isError).toBe(true);
        expect(result.content).toStrictEqual([{ text: "FORBIDDEN: no access to this room", type: "text" }]);
        expect(onprogress).toHaveBeenCalledTimes(1);

        await client.close();
    });

    it("cancels the stream when the caller aborts, and sends one unsubscribe for it", async () => {
        expect.assertions(2);

        vi.stubGlobal("WebSocket", StreamSocket);
        // The stream never completes on its own: it stays open until the client cancels it.
        streamFrames.script = (id) => [
            { id, type: "ack" },
            { data: CHUNKS[0], id, type: "chunk" },
        ];

        const client = await connected(serverFor());
        const controller = new AbortController();
        const firstProgress = new Promise<void>((resolve) => {
            client
                .callTool({ arguments: { args: { room: "r1" } }, name: "feed_tail" }, undefined, {
                    onprogress: () => {
                        resolve();
                    },
                    signal: controller.signal,
                })
                .catch(() => {
                    /* the aborted call rejects on the client; the assertion is on the wire */
                });
        });

        await firstProgress;
        controller.abort();
        await StreamSocket.whenSent("unsubscribe");

        const streamId = String(StreamSocket.sent.find((frame) => frame["type"] === "stream")?.["id"]);

        expect(StreamSocket.sent.filter((frame) => frame["type"] === "unsubscribe")).toStrictEqual([{ id: streamId, type: "unsubscribe" }]);
        expect(StreamSocket.sent.filter((frame) => frame["type"] === "stream")).toHaveLength(1);

        await client.close();
    });
});

describe("a stream tool when the deployment URL moves while it is open", () => {
    afterEach(resetStreamDouble);

    it("keeps the stream open on the deployment it started on, until it completes there", async () => {
        expect.assertions(2);

        vi.stubGlobal("WebSocket", StreamSocket);

        let url = "https://old.example";
        // The chunk arrives, and the stream then stays open until the test completes it.
        streamFrames.script = (id) => [
            { id, type: "ack" },
            { data: CHUNKS[0], id, type: "chunk" },
        ];

        const httpFetch = vi.fn<typeof fetch>(async () => Response.json({ result: [] }, { headers: { "content-type": "application/json" } }));
        const client = await connected(createFunctionMcpServer({ fetch: httpFetch, openRpcSpec: SPEC, token: "test-caller", url: () => url }));
        const pending = client.callTool({ arguments: { args: { room: "r1" } }, name: "feed_tail" });

        await StreamSocket.whenSent("stream");

        url = "https://new.example";

        await client.callTool({ name: "messages_list" });

        const streamId = String(StreamSocket.sent.find((frame) => frame["type"] === "stream")?.["id"]);

        StreamSocket.deliver({ id: streamId, type: "complete" });

        const result = await pending;

        expect(result.isError ?? false).toBe(false);
        expect(chunksOf(result.content)).toStrictEqual([CHUNKS[0]]);

        await client.close();
    });
});

describe("a stream tool through the stateless HTTP transport", () => {
    afterEach(resetStreamDouble);

    it("sends one progress per chunk over the transport, and the response body is still one JSON object", async () => {
        expect.assertions(6);

        vi.stubGlobal("WebSocket", StreamSocket);
        streamFrames.script = (id) => [
            { id, type: "ack" },
            ...CHUNKS.map((data) => {
                return { data, id, type: "chunk" };
            }),
            { id, type: "complete" },
        ];

        // `serveStateless` runs the transport with `enableJsonResponse`, which writes only the final response. The
        // spy shows the progress messages are produced and handed to the transport. The response body then has no
        // place for them, so the caller receives the chunks and no progress.
        const send = vi.spyOn(WebStandardStreamableHTTPServerTransport.prototype, "send");
        const request = new Request("https://mcp.example/mcp", {
            body: JSON.stringify({
                id: 1,
                jsonrpc: "2.0",
                method: "tools/call",
                params: { _meta: { progressToken: "tok-1" }, arguments: { args: { room: "r1" } }, name: "feed_tail" },
            }),
            headers: { accept: "application/json, text/event-stream", "content-type": "application/json" },
            method: "POST",
        });
        const response = await serveStateless(serverFor(), request);
        const body = (await response.json()) as { id: number; method?: string; result: { content: { text: string }[] } };
        const progress = send.mock.calls.filter(([message]) => (message as { method?: string }).method === "notifications/progress");

        expect(progress.map(([message]) => (message as unknown as { params: { progress: number } }).params.progress)).toStrictEqual([0, 1, 2]);
        expect(progress.every(([, options]) => (options as { relatedRequestId?: unknown } | undefined)?.relatedRequestId !== undefined)).toBe(true);
        expect(response.headers.get("content-type")).toContain("application/json");
        expect(body.method).toBeUndefined();
        expect(body.id).toBe(1);
        expect(JSON.parse(body.result.content[0]!.text)).toStrictEqual(CHUNKS);
    });
});
