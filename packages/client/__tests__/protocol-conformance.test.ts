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

import { decodeWire, encodeWire } from "../../../shared/wire-codec";
import { stableWireKey } from "../../../shared/wire-key";
import { LunoraClient } from "../src/lunora-client";
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
    const { cases } = readFixture("wire-codec.json") as { cases: { encoded: unknown; name: string }[] };

    it.each(cases.map((testCase) => [testCase.name, testCase.encoded] as const))("round-trips %s", (_name, encoded) => {
        expect.hasAssertions();

        // encode(decode(encoded)) === encoded proves both the decode of tagged
        // tokens and their canonical re-encode match the golden wire form.
        expect(encodeWire(decodeWire(encoded))).toStrictEqual(encoded);
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
    expect: { code?: string; kind: string; message?: string; valueWire?: unknown };
    frame: Record<string, unknown>;
    name: string;
}

interface WsFixtures {
    clientFrames: Record<string, unknown>;
    serverFrames: WsServerCase[];
    shape: {
        expectedRows: Record<string, unknown>[];
        pokeSequence: Record<string, unknown>[];
        "shape-subscribe-cold": unknown;
    };
}

describe("ws-frames fixtures", () => {
    const ws = readFixture("ws-frames.json") as WsFixtures;

    it("emits the connect + subscribe frames a cold subscription sends", () => {
        expect.hasAssertions();

        const client = makeWsClient();

        client.subscribe(fnRef("messages:list"), { channel: "general" }, () => undefined);
        latestSocket().open();

        const sent = latestSocket().sent.map((raw) => JSON.parse(raw));

        expect(sent[0]).toStrictEqual(ws.clientFrames.connect);
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
