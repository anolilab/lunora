import { afterEach, describe, expect, it } from "vitest";

import type { ShardDOState } from "../src/shard-do.js";
import { ShardDO } from "../src/shard-do.js";

/** Minimal concrete ShardDO — the keepalive registration runs in the base constructor. */
class TestShard extends ShardDO {
    // eslint-disable-next-line class-methods-use-this -- abstract stub; these tests never dispatch an RPC
    public override async handleRpc(): Promise<unknown> {
        return null;
    }
}

/** Stub for the `WebSocketRequestResponsePair` runtime global (absent under the node test env). */
class FakePair {
    public constructor(
        public readonly request: string,
        public readonly response: string,
    ) {}
}

type GlobalWithPair = { WebSocketRequestResponsePair?: unknown };

const baseState = (setWebSocketAutoResponse?: (pair: unknown) => void): ShardDOState => {
    return {
        acceptWebSocket: () => undefined,
        getWebSockets: () => [],
        setWebSocketAutoResponse,
        storage: { sql: {} },
    };
};

describe("shardDO websocket keepalive auto-response", () => {
    const globalScope = globalThis as GlobalWithPair;
    const original = globalScope.WebSocketRequestResponsePair;

    afterEach(() => {
        globalScope.WebSocketRequestResponsePair = original;
    });

    it("registers a cirrus-ping/cirrus-pong auto-response at construction", () => {
        expect.assertions(3);

        globalScope.WebSocketRequestResponsePair = FakePair;

        let captured: unknown;
        const shard = new TestShard(
            baseState((pair) => {
                captured = pair;
            }),
            {},
        );

        expect(shard).toBeInstanceOf(TestShard);
        expect(captured).toBeInstanceOf(FakePair);

        const pair = captured as FakePair;

        expect([pair.request, pair.response]).toStrictEqual(["cirrus-ping", "cirrus-pong"]);
    });

    it("degrades to a no-op when the runtime lacks setWebSocketAutoResponse", () => {
        expect.assertions(1);

        globalScope.WebSocketRequestResponsePair = FakePair;

        expect(() => new TestShard(baseState(), {})).not.toThrow();
    });

    it("degrades to a no-op when the WebSocketRequestResponsePair global is absent", () => {
        expect.assertions(2);

        globalScope.WebSocketRequestResponsePair = undefined;

        let called = false;
        const shard = new TestShard(
            baseState(() => {
                called = true;
            }),
            {},
        );

        expect(shard).toBeInstanceOf(TestShard);
        expect(called).toBe(false);
    });
});
