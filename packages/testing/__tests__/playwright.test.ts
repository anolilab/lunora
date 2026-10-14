/**
 * Tests for the Playwright wire-protocol double.
 *
 * These drive it with the exact frames `@lunora/client` sends and assert the exact
 * frames it expects back, so this file doubles as the executable spec of the browser
 * protocol — which is half the reason the double lives in the framework instead of
 * being re-derived in every adopter's e2e suite.
 */
import { describe, expect, it, vi } from "vitest";

import type { MockablePage, MockRoute, MockWebSocketRoute } from "../src/playwright";
import { mockLunora } from "../src/playwright";

/** A recorded server frame. */
type Frame = Record<string, unknown>;

/** A fake `page` that captures the installed route handlers so a test can drive them. */
const createFakePage = () => {
    const handlers = new Map<string, (route: MockRoute) => Promise<void> | void>();
    let socketHandler: ((ws: MockWebSocketRoute) => void) | undefined;
    const unrouted: string[] = [];

    const page: MockablePage = {
        route: async (url, handler) => {
            handlers.set(url, handler);
        },
        routeWebSocket: async (_url, handler) => {
            socketHandler = handler;
        },
        unroute: async (url) => {
            unrouted.push(url);
        },
    };

    /** Open a socket and return the frames the server sends plus a send-to-server hook. */
    const openSocket = (): { frames: Frame[]; send: (message: unknown) => void } => {
        const frames: Frame[] = [];
        let onMessage: ((message: string) => void) | undefined;

        socketHandler?.({
            onMessage: (handler) => {
                onMessage = handler;
            },
            send: (message) => frames.push(JSON.parse(message) as Frame),
        });

        return {
            frames,
            send: (message) => onMessage?.(JSON.stringify(message)),
        };
    };

    /** Issue an RPC POST (optionally against the batch path) and return the response. */
    const rpc = async (
        body: unknown,
        headers: Record<string, string> = {},
        options: { path?: string; raw?: string } = {},
    ): Promise<{ body: Frame; status: number }> => {
        let captured: { body: Frame; status: number } | undefined;
        const handler = handlers.get(options.path ?? "/_lunora/rpc");

        await handler?.({
            fulfill: async (response) => {
                captured = { body: JSON.parse(response.body ?? "{}") as Frame, status: response.status ?? 200 };
            },
            request: () => {
                return { headers: () => headers, postData: () => options.raw ?? JSON.stringify(body) };
            },
        });

        if (!captured) {
            throw new Error("the rpc route did not fulfill");
        }

        return captured;
    };

    return { handlers, openSocket, page, rpc, unrouted };
};

const row = (id: string, extra: Record<string, unknown> = {}): Record<string, unknown> & { _id: string } => {
    return { _id: id, userId: "u1", ...extra };
};

describe("mockLunora — shape replication", () => {
    it("seeds a cold shape_subscribe with an ack and a full insert poke", async () => {
        expect.assertions(5);

        const fake = createFakePage();

        await mockLunora(fake.page, {
            rows: { nodes: [row("n1", { text: "hello" }), row("n2", { text: "world" })] },
            shapes: { wholeOutline: { tables: ["nodes"] } },
        });

        const socket = fake.openSocket();

        socket.send({ id: "shape_1", shape: { name: "wholeOutline" }, type: "shape_subscribe" });

        // ack, then the poke triple. The client buffers parts and commits at
        // `pokeEnd`, so all three frames are load-bearing.
        expect(socket.frames.map((frame) => frame["type"])).toStrictEqual(["ack", "pokeStart", "pokePart", "pokeEnd"]);

        const part = socket.frames[2] as { rowsPatch: { key: string; op: string }[]; shapeId: string };

        expect(part.shapeId).toBe("shape_1");
        expect(part.rowsPatch.map((op) => op.key)).toStrictEqual(["n1", "n2"]);
        expect(part.rowsPatch.every((op) => op.op === "insert")).toBe(true);
        // `pokeEnd` carries the checkpoint the client replays as `sinceCheckpoint`.
        expect(socket.frames[3]?.["checkpoint"]).toBe(1);
    });

    it("narrows a shape by its where clause", async () => {
        expect.assertions(1);

        const fake = createFakePage();

        await mockLunora(fake.page, {
            rows: { nodes: [row("mine"), row("theirs", { userId: "u2" })] },
            shapes: { myNodes: { tables: ["nodes"], where: { userId: "u1" } } },
        });

        const socket = fake.openSocket();

        socket.send({ id: "shape_1", shape: { name: "myNodes" }, type: "shape_subscribe" });

        expect((socket.frames[2] as { rowsPatch: { key: string }[] }).rowsPatch.map((op) => op.key)).toStrictEqual(["mine"]);
    });

    it("pokes a live shape on insert, patch, and delete", async () => {
        expect.assertions(3);

        const fake = createFakePage();
        const lunora = await mockLunora(fake.page, { rows: { nodes: [] }, shapes: { wholeOutline: { tables: ["nodes"] } } });

        const socket = fake.openSocket();

        socket.send({ id: "shape_1", shape: { name: "wholeOutline" }, type: "shape_subscribe" });
        socket.frames.length = 0;

        await lunora.insert("nodes", row("n1", { text: "a" }));

        expect((socket.frames[1] as { rowsPatch: { op: string }[] }).rowsPatch[0]?.op).toBe("insert");

        socket.frames.length = 0;
        await lunora.patch("nodes", "n1", { text: "b" });

        expect((socket.frames[1] as { rowsPatch: { op: string; value: { text: string } }[] }).rowsPatch[0]?.value.text).toBe("b");

        socket.frames.length = 0;
        await lunora.remove("nodes", "n1");

        expect((socket.frames[1] as { rowsPatch: { op: string }[] }).rowsPatch[0]?.op).toBe("delete");
    });

    it("sends a delete when a patch moves a row out of the shape's partition", async () => {
        expect.assertions(1);

        const fake = createFakePage();
        const lunora = await mockLunora(fake.page, {
            rows: { nodes: [row("n1")] },
            shapes: { myNodes: { tables: ["nodes"], where: { userId: "u1" } } },
        });

        const socket = fake.openSocket();

        socket.send({ id: "shape_1", shape: { name: "myNodes" }, type: "shape_subscribe" });
        socket.frames.length = 0;

        await lunora.patch("nodes", "n1", { userId: "u2" });

        // An `update` here would leave the client showing a row it may no longer see.
        expect((socket.frames[1] as { rowsPatch: { op: string }[] }).rowsPatch[0]?.op).toBe("delete");
    });

    it("stops poking a shape after shape_unsubscribe", async () => {
        expect.assertions(1);

        const fake = createFakePage();
        const lunora = await mockLunora(fake.page, { rows: { nodes: [] }, shapes: { wholeOutline: { tables: ["nodes"] } } });

        const socket = fake.openSocket();

        socket.send({ id: "shape_1", shape: { name: "wholeOutline" }, type: "shape_subscribe" });
        socket.send({ id: "shape_1", type: "shape_unsubscribe" });
        socket.frames.length = 0;

        await lunora.insert("nodes", row("n1"));

        expect(socket.frames).toStrictEqual([]);
    });

    it("ignores a shape the app subscribes to but the test never declared", async () => {
        expect.assertions(2);

        const fake = createFakePage();

        await mockLunora(fake.page, { rows: { nodes: [row("n1")] }, shapes: {} });

        const socket = fake.openSocket();

        socket.send({ id: "shape_1", shape: { name: "unknownShape" }, type: "shape_subscribe" });

        // Acked (so the client doesn't hang on the handshake), seeded empty.
        expect(socket.frames[0]).toStrictEqual({ id: "shape_1", type: "ack" });
        expect((socket.frames[2] as { rowsPatch: unknown[] } | undefined)?.rowsPatch).toStrictEqual([]);
    });
});

describe("mockLunora — watermarks", () => {
    it("advances and echoes the per-client watermark on a mutator push", async () => {
        expect.assertions(3);

        const fake = createFakePage();
        const lunora = await mockLunora(fake.page);

        const first = await fake.rpc({ args: {}, functionPath: "mutators:send" }, { "x-lunora-client-id": "c1", "x-lunora-client-seq": "1" });

        // The overlay-clearing number: without it a `@lunora/db` mutator holds its
        // optimistic row forever.
        expect(first.body["lastMutationId"]).toBe(1);

        const second = await fake.rpc({ args: {}, functionPath: "mutators:send" }, { "x-lunora-client-id": "c1", "x-lunora-client-seq": "2" });

        expect(second.body["lastMutationId"]).toBe(2);
        expect(lunora.watermarks()).toStrictEqual({ c1: 2 });
    });

    it("keeps watermarks separate per client id", async () => {
        expect.assertions(1);

        const fake = createFakePage();
        const lunora = await mockLunora(fake.page);

        await fake.rpc({ functionPath: "mutators:send" }, { "x-lunora-client-id": "c1", "x-lunora-client-seq": "3" });
        await fake.rpc({ functionPath: "mutators:send" }, { "x-lunora-client-id": "c2", "x-lunora-client-seq": "1" });

        expect(lunora.watermarks()).toStrictEqual({ c1: 3, c2: 1 });
    });

    it("carries the watermark on shape pokes so an overlay clears when the row lands", async () => {
        expect.assertions(1);

        const fake = createFakePage();
        const lunora = await mockLunora(fake.page, { rows: { nodes: [] }, shapes: { wholeOutline: { tables: ["nodes"] } } });

        const socket = fake.openSocket();

        socket.send({ id: "shape_1", shape: { name: "wholeOutline" }, type: "shape_subscribe" });
        await fake.rpc({ functionPath: "mutators:send" }, { "x-lunora-client-id": "c1", "x-lunora-client-seq": "7" });
        socket.frames.length = 0;

        await lunora.insert("nodes", row("n1"));

        expect((socket.frames[1] as { lastMutationId: number }).lastMutationId).toBe(7);
    });

    it("does not advance the watermark for a rejected write", async () => {
        expect.assertions(3);

        const fake = createFakePage();
        const lunora = await mockLunora(fake.page);

        lunora.failWrites("CONFLICT");

        const rejected = await fake.rpc({ functionPath: "mutators:send" }, { "x-lunora-client-id": "c1", "x-lunora-client-seq": "1" });

        expect(rejected.status).toBe(400);
        expect((rejected.body["error"] as { code: string }).code).toBe("CONFLICT");
        // The DO only advances on a write it applied; advancing here would hide the
        // client's reissue path.
        expect(lunora.watermarks()).toStrictEqual({});
    });

    it("failWrites leaves reads alone", async () => {
        expect.assertions(2);

        const fake = createFakePage();
        const lunora = await mockLunora(fake.page, { functions: { "nodes:list": [{ _id: "n1" }] } });

        lunora.failWrites("CONFLICT");

        // A rollback-UI test sets failWrites and still needs its reads to work —
        // otherwise the data under test collapses and masks the behaviour.
        const read = await fake.rpc({ functionPath: "nodes:list" });

        expect(read.status).toBe(200);
        expect(read.body["result"]).toStrictEqual([{ _id: "n1" }]);
    });

    it("resumes accepting writes when failWrites is turned off", async () => {
        expect.assertions(1);

        const fake = createFakePage();
        const lunora = await mockLunora(fake.page);

        lunora.failWrites("CONFLICT");
        lunora.failWrites(false);

        const accepted = await fake.rpc({ functionPath: "mutators:send" }, { "x-lunora-client-id": "c1", "x-lunora-client-seq": "1" });

        expect(accepted.status).toBe(200);
    });
});

describe("mockLunora — failure injection", () => {
    it("suppressPokes drops pokes while still accepting the write", async () => {
        expect.assertions(3);

        const fake = createFakePage();
        const lunora = await mockLunora(fake.page, { rows: { nodes: [] }, shapes: { wholeOutline: { tables: ["nodes"] } } });

        const socket = fake.openSocket();

        socket.send({ id: "shape_1", shape: { name: "wholeOutline" }, type: "shape_subscribe" });
        socket.frames.length = 0;

        lunora.suppressPokes();
        await lunora.insert("nodes", row("n1"));

        // No poke reaches the client — the dropped-poke path that exercises the
        // checkpoint fallback rather than a dead connection.
        expect(socket.frames).toStrictEqual([]);
        // The write DID land server-side.
        expect(lunora.rows("nodes")).toHaveLength(1);

        lunora.suppressPokes(false);
        await lunora.resync();

        expect((socket.frames[1] as { rowsPatch: unknown[] }).rowsPatch).toHaveLength(1);
    });

    it("suppressPokes also suppresses live-query settled frames", async () => {
        expect.assertions(1);

        const fake = createFakePage();
        const lunora = await mockLunora(fake.page, { functions: { "nodes:list": [] }, rows: { nodes: [] } });

        const socket = fake.openSocket();

        socket.send({ id: "sub_1", query: { functionPath: "nodes:list" }, type: "subscribe" });
        socket.frames.length = 0;

        lunora.suppressPokes();
        await lunora.insert("nodes", row("n1"));

        // Otherwise only half the dropped-poke failure mode is reproduced: the shape
        // goes quiet but queries still get invalidated.
        expect(socket.frames).toStrictEqual([]);
    });

    it("resync re-seeds every live shape, as a reconnect would", async () => {
        expect.assertions(1);

        const fake = createFakePage();
        const lunora = await mockLunora(fake.page, {
            rows: { nodes: [row("n1")] },
            shapes: { a: { tables: ["nodes"] }, b: { tables: ["nodes"] } },
        });

        const socket = fake.openSocket();

        socket.send({ id: "shape_a", shape: { name: "a" }, type: "shape_subscribe" });
        socket.send({ id: "shape_b", shape: { name: "b" }, type: "shape_subscribe" });
        socket.frames.length = 0;

        await lunora.resync();

        expect(socket.frames.filter((frame) => frame["type"] === "pokePart")).toHaveLength(2);
    });
});

describe("mockLunora — queries", () => {
    it("acks a subscribe and answers it from the configured function", async () => {
        expect.assertions(3);

        const fake = createFakePage();

        await mockLunora(fake.page, { functions: { "nodes:list": [{ _id: "n1" }] } });

        const socket = fake.openSocket();

        socket.send({ id: "sub_1", query: { args: {}, functionPath: "nodes:list" }, type: "subscribe" });

        expect(socket.frames[0]).toStrictEqual({ id: "sub_1", type: "ack" });
        expect(socket.frames[1]?.["type"]).toBe("data");
        expect(socket.frames[1]?.["data"]).toStrictEqual([{ _id: "n1" }]);
    });

    it("resolves an RPC call from a function of its args", async () => {
        expect.assertions(1);

        const fake = createFakePage();

        await mockLunora(fake.page, {
            functions: {
                "nodes:get": (args: Record<string, unknown>) => {
                    return { id: args["id"] };
                },
            },
        });

        const answered = await fake.rpc({ args: { id: "n9" }, functionPath: "nodes:get" });

        expect(answered.body["result"]).toStrictEqual({ id: "n9" });
    });

    it("settles live queries when the data changes so they re-read", async () => {
        expect.assertions(2);

        const fake = createFakePage();
        const lunora = await mockLunora(fake.page, { functions: { "nodes:list": [] }, rows: { nodes: [] } });

        const socket = fake.openSocket();

        socket.send({ id: "sub_1", query: { functionPath: "nodes:list" }, type: "subscribe" });
        socket.frames.length = 0;

        await lunora.insert("nodes", row("n1"));

        expect(socket.frames[0]?.["type"]).toBe("settled");
        expect(socket.frames[0]?.["id"]).toBe("sub_1");
    });

    it("stops settling after unsubscribe", async () => {
        expect.assertions(1);

        const fake = createFakePage();
        const lunora = await mockLunora(fake.page, { functions: { "nodes:list": [] } });

        const socket = fake.openSocket();

        socket.send({ id: "sub_1", query: { functionPath: "nodes:list" }, type: "subscribe" });
        socket.send({ id: "sub_1", type: "unsubscribe" });
        socket.frames.length = 0;

        await lunora.insert("nodes", row("n1"));

        expect(socket.frames).toStrictEqual([]);
    });
});

describe("mockLunora — lifecycle", () => {
    it("clears a previous installation's routes so a stale handler can't serve stale rows", async () => {
        expect.assertions(1);

        const fake = createFakePage();

        await mockLunora(fake.page, { rows: { nodes: [row("old")] } });
        await mockLunora(fake.page, { rows: { nodes: [row("new")] } });

        // Playwright matches `unroute` against the pattern the handler was REGISTERED
        // with, so a `/**` glob would remove nothing — these are the exact registered
        // paths. (Two installs × two paths.)
        expect(fake.unrouted).toStrictEqual(["/_lunora/rpc", "/_lunora/rpc-batch", "/_lunora/rpc", "/_lunora/rpc-batch"]);
    });

    it("stops sending frames after dispose", async () => {
        expect.assertions(1);

        const fake = createFakePage();
        const lunora = await mockLunora(fake.page, { rows: { nodes: [] }, shapes: { wholeOutline: { tables: ["nodes"] } } });

        const socket = fake.openSocket();

        socket.send({ id: "shape_1", shape: { name: "wholeOutline" }, type: "shape_subscribe" });
        await lunora.dispose();
        socket.frames.length = 0;

        await lunora.insert("nodes", row("n1"));

        expect(socket.frames).toStrictEqual([]);
    });

    it("honors a custom base path", async () => {
        expect.assertions(2);

        const fake = createFakePage();
        const routeSpy = vi.fn<MockablePage["route"]>(async () => undefined);

        await mockLunora({ ...fake.page, route: routeSpy }, { path: "/sync" });

        expect(routeSpy).toHaveBeenCalledWith("/sync/rpc", expect.any(Function));
        expect(routeSpy).toHaveBeenCalledWith("/sync/rpc-batch", expect.any(Function));
    });

    it("answers the coalesced batch path, so a replayed offline write can't reach the origin", async () => {
        expect.assertions(2);

        const fake = createFakePage();

        await mockLunora(fake.page, { functions: { "nodes:list": [] } });

        // `client.mutation(...)` reaches `/rpc-batch` via offline replay
        // (`replayBatched`); routing only `/rpc` would let that fall through to the real
        // deployment.
        expect(fake.handlers.has("/_lunora/rpc-batch")).toBe(true);

        const batched = await fake.rpc({ functionPath: "nodes:list" }, {}, { path: "/_lunora/rpc-batch" });

        expect(batched.status).toBe(200);
    });

    it("answers a malformed body with a 400 instead of leaving the request hanging", async () => {
        expect.assertions(2);

        const fake = createFakePage();

        await mockLunora(fake.page);

        // An unhandled throw in a route handler never fulfils, so the test would hang on
        // a network timeout rather than showing the cause.
        const answered = await fake.rpc(undefined, {}, { raw: "not json" });

        expect(answered.status).toBe(400);
        expect((answered.body["error"] as { code: string }).code).toBe("BAD_REQUEST");
    });

    it("throws a clear error when patching a row that does not exist", async () => {
        expect.assertions(1);

        const fake = createFakePage();
        const lunora = await mockLunora(fake.page, { rows: { nodes: [] } });

        await expect(lunora.patch("nodes", "missing", { text: "x" })).rejects.toThrow('no row "missing" in table "nodes"');
    });
});
