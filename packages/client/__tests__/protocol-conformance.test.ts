/**
 * Protocol-conformance suite: asserts the reference TypeScript client produces
 * and consumes the language-independent golden frames in `protocol/fixtures/`.
 *
 * The exact same fixture files back the Python SDK's `test_conformance.py`, so a
 * frame that changes here (or there) is caught on both sides. See
 * `protocol/README.md` for the normative spec.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

import { MAX_BATCH_ENTRIES } from "../../../shared/batch-wire";
import { decodeWire, encodeWire } from "../../../shared/wire-codec";
import { stableWireKey } from "../../../shared/wire-key";
import { LunoraClient } from "../src/lunora-client";
import { OfflineQueue } from "../src/offline-queue";
import type { FunctionReference } from "../src/types";

const readFixture = (name: string): unknown => {
    const path = fileURLToPath(new URL(`../../../protocol/fixtures/${name}`, import.meta.url));

    return JSON.parse(readFileSync(path, "utf8"));
};

const fnRef = (ref: string): FunctionReference => {
    return { __lunoraRef: ref };
};

const jsonResponse = (body: unknown, init: ResponseInit = {}): Response =>
    Response.json(body, { headers: { "content-type": "application/json" }, status: 200, ...init });

// --- Wire value codec -------------------------------------------------------

describe("wire-codec fixtures", () => {
    const { cases, rejected } = readFixture("wire-codec.json") as {
        cases: { encoded: unknown; name: string; reencoded?: unknown }[];
        rejected: { encoded: unknown; name: string }[];
    };

    it.each(cases.map((testCase) => [testCase.name, testCase] as const))("round-trips %s", (_name, testCase) => {
        expect.hasAssertions();

        // encode(decode(encoded)) === encoded proves both the decode of tagged
        // tokens and their canonical re-encode match the golden wire form.
        //
        // A few shapes are legitimately NOT fixed points of that identity — a
        // bare `[TAG]` array is escaped on the way back out, and an object field
        // holding the `undefined` tag is dropped, matching `JSON.stringify`.
        // Those carry an explicit `reencoded`; see the fixture's `$comment`.
        const expected = "reencoded" in testCase ? testCase.reencoded : testCase.encoded;

        expect(encodeWire(decodeWire(testCase.encoded))).toStrictEqual(expected);
    });

    // The other half of the fixture: wire values a conforming codec MUST refuse.
    // These drive all eight SDK suites, and the reference implementation is the
    // normative one — holding the ports to a rejection list the reference is
    // never checked against is exactly backwards.
    it.each(rejected.map((testCase) => [testCase.name, testCase.encoded] as const))("rejects %s", (_name, encoded) => {
        expect.hasAssertions();

        // Only that it throws with a message, not which one: a bad base64 payload
        // surfaces the host's own `atob` DOMException, whose wording differs
        // between runtimes, while the codec's own refusals are `wire-codec:`
        // TypeErrors. Pinning either spelling would fail on the other.
        expect(() => decodeWire(encoded)).toThrow(/./u);
    });
});

// --- Stable subscription key ------------------------------------------------

describe("stable-wire-key fixtures", () => {
    const data = readFixture("stable-wire-key.json") as {
        cases: { args: Record<string, unknown>; key: string; name: string }[];
        typed: { key: string; name: string; wireArgs: unknown }[];
    };

    it.each(data.cases.map((testCase) => [testCase.name, testCase.args, testCase.key] as const))("keys pure-JSON %s", (_name, args, key) => {
        expect.hasAssertions();
        expect(stableWireKey(args)).toBe(key);
    });

    it.each(data.typed.map((testCase) => [testCase.name, testCase.wireArgs, testCase.key] as const))("keys typed %s", (_name, wireArgs, key) => {
        expect.hasAssertions();
        expect(stableWireKey(decodeWire(wireArgs))).toBe(key);
    });
});

// --- Offline queue (the reference the eight ports are held to) --------------

interface QueueFixtures {
    offlineQueue: {
        batchReplay: { maxEntries: number };
        fifo: { drained: string[]; enqueue: string[]; sizeAfterDrain: number; sizeAfterEnqueue: number };
        overflow: { code: string; enqueue: string[]; evicted: string[]; maxItems: number; remaining: string[] };
        shardDrain: {
            drained: string[];
            drainShardKey: null | string;
            entries: { id: string; shardKey: null | string }[];
            remaining: string[];
        };
    };
}

describe("offline-queue fixtures", () => {
    // `offline-optimistic.json` says `@lunora/client` is the reference every port
    // is held to — and no test here read a byte of it, so the reference could move
    // and leave eight suites pinned to numbers it no longer produces, with nothing
    // red. These drive the real `OfflineQueue` against the same scenarios the
    // ports run.
    const { offlineQueue } = readFixture("offline-optimistic.json") as QueueFixtures;

    /** A queue entry whose `functionPath` carries the fixture's id, so a drain is identifiable. */
    const entry = (id: string, shardKey?: null | string, reject: (error: unknown) => void = () => undefined) => {
        return {
            args: {},
            functionPath: id,
            reject,
            resolve: () => undefined,
            ...(shardKey === null ? {} : { shardKey }),
        };
    };

    it("replays in FIFO order", () => {
        expect.hasAssertions();

        const { drained, enqueue, sizeAfterDrain, sizeAfterEnqueue } = offlineQueue.fifo;
        const queue = new OfflineQueue();

        for (const id of enqueue) {
            queue.enqueue(entry(id));
        }

        expect(queue.size).toBe(sizeAfterEnqueue);
        expect(queue.drain().map((item) => item.functionPath)).toStrictEqual(drained);
        expect(queue.size).toBe(sizeAfterDrain);
    });

    it("drains one shard and leaves the rest queued, treating an absent and an empty shard key as one shard", () => {
        expect.hasAssertions();

        const { drainShardKey, drained, entries, remaining } = offlineQueue.shardDrain;
        const queue = new OfflineQueue();

        for (const item of entries) {
            queue.enqueue(entry(item.id, item.shardKey));
        }

        // The client's own predicate: `shardKey ?? ""`. A port comparing the two
        // strictly leaves the `""` entry queued forever, because nothing ever
        // flushes the shard named `""` — which is why the fixture carries it.
        const key = drainShardKey ?? "";
        const taken = queue.drain((item) => (item.shardKey ?? "") === key);

        expect(taken.map((item) => item.functionPath)).toStrictEqual(drained);
        expect(queue.drain().map((item) => item.functionPath)).toStrictEqual(remaining);
    });

    it("evicts the oldest entry past capacity, with a coded reason", () => {
        expect.hasAssertions();

        const { code, enqueue, evicted, maxItems, remaining } = offlineQueue.overflow;
        const rejected: { code: string; id: string }[] = [];
        const queue = new OfflineQueue({ maxItems });

        for (const id of enqueue) {
            queue.enqueue(entry(id, null, (error: unknown) => rejected.push({ code: (error as { code: string }).code, id })));
        }

        expect(rejected.map((item) => item.id)).toStrictEqual(evicted);
        expect(rejected.map((item) => item.code)).toStrictEqual(evicted.map(() => code));
        expect(queue.drain().map((item) => item.functionPath)).toStrictEqual(remaining);
    });
});

// --- Batch entry cap --------------------------------------------------------

describe("batch entry cap", () => {
    it("matches the value every port reads from the fixture", () => {
        expect.hasAssertions();

        // The cap is normative and duplicated by hand in ten places — this file's
        // constant, the worker and shard-DO enforcement that import it, and the
        // eight ports, which each hard-code the number. Nothing reconciled them,
        // and the failure is silent in the worst direction: lower the server's cap
        // and a client still chunking at the old one takes a coded 400, which
        // protocol/README.md §4.3 makes a TERMINAL verdict — the durable writes are
        // discarded rather than retried. Every SDK now reads it from here too, via
        // `batch_entry_cap_matches_protocol` in protocol/conformance-cases.json.
        const offline = readFixture("offline-optimistic.json") as { offlineQueue: { batchReplay: { maxEntries: number } } };

        expect(MAX_BATCH_ENTRIES).toBe(offline.offlineQueue.batchReplay.maxEntries);
    });
});

// --- HTTP RPC ---------------------------------------------------------------

interface RpcRequestCase {
    args?: Record<string, unknown>;
    argsWire?: Record<string, unknown>;
    body: unknown;
    functionPath: string;
    name: string;
    shardKey?: string;
}

interface RpcErrorCase {
    code: string;
    dataWire?: unknown;
    message: string;
    name: string;
    response: unknown;
}

interface RpcFixture {
    request: { cases: RpcRequestCase[] };
    responseError: RpcErrorCase[];
    responseOk: { name: string; response: { result: unknown } }[];
}

describe("rpc fixtures", () => {
    const rpc = readFixture("rpc.json") as RpcFixture;

    it.each(rpc.request.cases.map((testCase) => [testCase.name, testCase] as const))("builds request body %s", async (_name, testCase) => {
        expect.hasAssertions();

        const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({ result: null }));
        const client = new LunoraClient({ fetch: fetchMock, url: "https://app.example" });
        const args = testCase.argsWire ? (decodeWire(testCase.argsWire) as Record<string, unknown>) : (testCase.args ?? {});

        await client.query(fnRef(testCase.functionPath), args, testCase.shardKey === undefined ? {} : { shardKey: testCase.shardKey });

        const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];

        expect(JSON.parse(init.body as string)).toStrictEqual(testCase.body);
    });

    it.each(rpc.responseOk.map((testCase) => [testCase.name, testCase.response] as const))("decodes ok response %s", async (_name, response) => {
        expect.hasAssertions();

        const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse(response));
        const client = new LunoraClient({ fetch: fetchMock, url: "https://app.example" });

        const value = await client.query(fnRef("docs:get"), {});

        // The decoded result re-encodes to the golden `result` wire form.
        expect(encodeWire(value)).toStrictEqual(response.result);
    });

    it.each(rpc.responseError.map((testCase) => [testCase.name, testCase] as const))("raises error response %s", async (_name, testCase) => {
        expect.hasAssertions();

        const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse(testCase.response, { status: 400 }));
        const client = new LunoraClient({ fetch: fetchMock, url: "https://app.example" });

        const thrown = (await client.query(fnRef("docs:get"), {}).catch((error: unknown) => error)) as Error & { code?: string };

        expect(thrown.code).toBe(testCase.code);
        expect(thrown.message).toBe(testCase.message);
    });

    const errorsWithData = rpc.responseError.filter((testCase) => testCase.dataWire !== undefined);

    it.each(errorsWithData.map((testCase) => [testCase.name, testCase] as const))("wire-decodes error data %s", async (_name, testCase) => {
        expect.hasAssertions();

        const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse(testCase.response, { status: 429 }));
        const client = new LunoraClient({ fetch: fetchMock, url: "https://app.example" });

        const thrown = (await client.query(fnRef("docs:get"), {}).catch((error: unknown) => error)) as Error & { data?: unknown };

        expect(encodeWire(thrown.data)).toStrictEqual(testCase.dataWire);
    });
});

// --- WebSocket frames -------------------------------------------------------

interface MockSocket {
    open: () => void;
    receive: (payload: unknown) => void;
    sent: string[];
}

const sockets: MockSocket[] = [];

const createMockWebSocket = (): typeof WebSocket => {
    class WS {
        public readyState = 0;

        public sent: string[] = [];

        private readonly listeners = new Map<string, ((event?: unknown) => void)[]>();

        public constructor() {
            sockets.push(this);
        }

        public addEventListener(type: string, listener: (event?: unknown) => void): void {
            const existing = this.listeners.get(type) ?? [];

            existing.push(listener);
            this.listeners.set(type, existing);
        }

        public open(): void {
            this.readyState = 1;
            this.dispatch("open");
        }

        public receive(payload: unknown): void {
            this.dispatch("message", { data: typeof payload === "string" ? payload : JSON.stringify(payload) });
        }

        public send(data: string): void {
            this.sent.push(data);
        }

        public close(): void {
            this.readyState = 3;
            this.dispatch("close");
        }

        private dispatch(type: string, event?: unknown): void {
            for (const listener of this.listeners.get(type) ?? []) {
                listener(event);
            }
        }
    }

    return WS as unknown as typeof WebSocket;
};

const latestSocket = (): MockSocket => {
    const last = sockets.at(-1);

    if (!last) {
        throw new Error("no socket created");
    }

    return last;
};

const makeWsClient = (): LunoraClient =>
    new LunoraClient({
        clientId: "client-test",
        fetch: vi.fn<typeof fetch>(async () => jsonResponse({ result: null })),
        url: "https://app.example",
        WebSocket: createMockWebSocket(),
    });

interface WsServerCase {
    /** Cached value the frame is applied ON TOP of; absent means the frame replaces wholesale. */
    baseWire?: unknown;
    expect: { code?: string; kind: string; message?: string; valueWire?: unknown };
    frame: Record<string, unknown>;
    name: string;
}

interface WsFixtures {
    clientFrames: Record<string, unknown>;
    /** Merge cases, only for a client that announced the `pageDelta` capability. */
    pageDeltaFrames: WsServerCase[];
    serverFrames: WsServerCase[];
    shape: {
        expectedRows: Record<string, unknown>[];
        pokeSequence: Record<string, unknown>[];
        "shape-subscribe-cold": unknown;
    };
    /** A live query consumed as the language's own pull type; see the fixture's `$comment`. */
    stream: { frames: Record<string, unknown>[]; subscriptionId: string; yielded: unknown[] };
}

describe("ws-frames fixtures", () => {
    const ws = readFixture("ws-frames.json") as WsFixtures;

    it("emits the connect + subscribe frames a cold subscription sends", () => {
        expect.hasAssertions();

        const client = makeWsClient();

        client.subscribe(fnRef("messages:list"), { channel: "general" }, () => undefined);
        latestSocket().open();

        const sent = latestSocket().sent.map((raw) => JSON.parse(raw));

        // The reference client implements `pageDelta`, so it emits the
        // capability-announcing form. The plain `connect` fixture stays the
        // conforming shape for an SDK that implements no tokens — see the
        // fixture file's `$comment` and protocol README 5.1.1.
        expect(sent[0]).toStrictEqual(ws.clientFrames["connect-with-caps"]);
        expect(sent[1]).toStrictEqual(ws.clientFrames["subscribe-cold"]);
    });

    it("emits a shape_subscribe frame", () => {
        expect.hasAssertions();

        const client = makeWsClient();

        client.subscribeShape({ args: { room: "general" }, name: "roomMessages" }, () => undefined);
        latestSocket().open();

        const shapeFrame = latestSocket()
            .sent.map((raw) => JSON.parse(raw))
            .find((frame) => frame.type === "shape_subscribe");

        expect(shapeFrame).toStrictEqual(ws.shape["shape-subscribe-cold"]);
    });

    const dataFrames = ws.serverFrames.filter((testCase) => testCase.expect.kind === "data");

    it.each(dataFrames.map((testCase) => [testCase.name, testCase] as const))("delivers data frame %s", (_name, testCase) => {
        expect.hasAssertions();

        const client = makeWsClient();
        const values: unknown[] = [];

        client.subscribe(fnRef("messages:list"), { channel: "general" }, (value) => values.push(value));
        latestSocket().open();
        latestSocket().receive(testCase.frame);

        expect(values).toHaveLength(1);
        expect(encodeWire(values[0])).toStrictEqual(testCase.expect.valueWire);
    });

    // `pageDeltaFrames`, not `serverFrames`: these apply ON TOP of a cached
    // value instead of replacing it, and every SDK iterates `serverFrames`
    // wholesale — putting a merge case there fails all seven of them. Only an
    // SDK that announced `pageDelta` should run these. Each seeds `baseWire`
    // via a `data` frame, then asserts the merged result; together they pin the
    // insert PLACEMENT the server relies on every client sharing (README 5.1.1).
    it.each(ws.pageDeltaFrames.map((testCase) => [testCase.name, testCase] as const))("merges delta frame %s into the cached value", (_name, testCase) => {
        expect.hasAssertions();

        const client = makeWsClient();
        const values: unknown[] = [];

        client.subscribe(fnRef("messages:list"), { channel: "general" }, (value) => values.push(value));
        latestSocket().open();
        latestSocket().receive({ data: testCase.baseWire, id: testCase.frame["id"], type: "data" });
        latestSocket().receive(testCase.frame);

        expect(values).toHaveLength(2);
        expect(encodeWire(values[1])).toStrictEqual(testCase.expect.valueWire);
    });

    const errorFrames = ws.serverFrames.filter((testCase) => testCase.expect.kind === "error");

    it.each(errorFrames.map((testCase) => [testCase.name, testCase] as const))("delivers error frame %s", (_name, testCase) => {
        expect.hasAssertions();

        const client = makeWsClient();
        const errors: { code?: string; message: string }[] = [];

        client.subscribe(fnRef("messages:list"), { channel: "general" }, () => undefined, {
            onError: (error) => errors.push(error),
        });
        latestSocket().open();
        latestSocket().receive(testCase.frame);

        expect(errors).toHaveLength(1);
        expect(errors[0]?.code).toBe(testCase.expect.code);
        expect(errors[0]?.message).toBe(testCase.expect.message);
    });

    it("delivers a subscription's frame values in order", () => {
        expect.hasAssertions();

        // The `stream` section: every port consumes a live query as its own PULL
        // type (an async generator, a channel, an Enumerator) and must yield
        // exactly what the callback form delivers, decoded. This reference has no
        // pull type — a callback IS the JS idiom — so it asserts the other half of
        // that equality, which is the half the ports are held to. All eight suites
        // read this section and the reference read none of it.
        const client = makeWsClient();
        const values: unknown[] = [];

        client.subscribe(fnRef("messages:list"), { channel: "general" }, (value) => values.push(value));
        latestSocket().open();

        for (const frame of ws.stream.frames) {
            latestSocket().receive(frame);
        }

        expect(values).toStrictEqual(ws.stream.yielded);

        const subscribeFrame = latestSocket()
            .sent.map((raw) => JSON.parse(raw))
            .find((frame) => frame.type === "subscribe");

        // `sub_1` is the id every port mints for a first subscription, and the
        // frames above are addressed to it.
        expect(subscribeFrame.id).toBe(ws.stream.subscriptionId);
    });

    it("materialises rows from a poke sequence", () => {
        expect.hasAssertions();

        const client = makeWsClient();
        const rowSets: Record<string, unknown>[][] = [];

        client.subscribeShape({ args: { room: "general" }, name: "roomMessages" }, (rows) => rowSets.push(rows));
        latestSocket().open();

        for (const frame of ws.shape.pokeSequence) {
            latestSocket().receive(frame);
        }

        expect(rowSets.at(-1)).toStrictEqual(ws.shape.expectedRows);
    });
});
