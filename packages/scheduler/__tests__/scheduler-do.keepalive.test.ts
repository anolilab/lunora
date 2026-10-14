import { afterEach, describe, expect, it } from "vitest";

import type { SchedulerDOState } from "../src/scheduler-do";
import { SchedulerDO } from "../src/scheduler-do";

/** Stub for the `WebSocketRequestResponsePair` runtime global (absent under the node test env). */
class FakePair {
    public constructor(
        public readonly request: string,
        public readonly response: string,
    ) {}
}

type GlobalWithPair = { WebSocketRequestResponsePair?: unknown };

const baseState = (setWebSocketAutoResponse?: (pair: unknown) => void): SchedulerDOState => {
    return {
        setWebSocketAutoResponse,
        storage: {
            delete: async () => 0,
            deleteAlarm: async () => undefined,
            get: async () => undefined,
            getAlarm: async () => null,
            list: async () => new Map(),
            put: async () => undefined,
            setAlarm: async () => undefined,
        },
    };
};

describe("schedulerDO websocket keepalive auto-response", () => {
    const globalScope = globalThis as GlobalWithPair;
    const original = globalScope.WebSocketRequestResponsePair;

    afterEach(() => {
        globalScope.WebSocketRequestResponsePair = original;
    });

    // The regression this pins: the client's `openManagedSocket` heartbeat
    // sends `lunora-ping` on every scheduled `/ws` subscription too, exactly
    // like the shard socket. ShardDO answers it via a hibernation-safe
    // `setWebSocketAutoResponse` pair; before this fix SchedulerDO never
    // registered one, so an idle scheduled socket's ping went unanswered and
    // the client's own watchdog force-closed it every ~90s — a reconnect
    // storm that also defeated hibernation (each unanswered ping woke the DO).
    it("registers a lunora-ping/lunora-pong auto-response at construction, mirroring ShardDO", () => {
        expect.assertions(3);

        globalScope.WebSocketRequestResponsePair = FakePair;

        let captured: unknown;
        const scheduler = new SchedulerDO(
            baseState((pair) => {
                captured = pair;
            }),
            {},
        );

        expect(scheduler).toBeInstanceOf(SchedulerDO);
        expect(captured).toBeInstanceOf(FakePair);

        const pair = captured as FakePair;

        expect([pair.request, pair.response]).toStrictEqual(["lunora-ping", "lunora-pong"]);
    });

    it("degrades to a no-op when the runtime lacks setWebSocketAutoResponse", () => {
        expect.assertions(1);

        globalScope.WebSocketRequestResponsePair = FakePair;

        expect(() => new SchedulerDO(baseState(), {})).not.toThrow();
    });

    it("degrades to a no-op when the WebSocketRequestResponsePair global is absent", () => {
        expect.assertions(2);

        globalScope.WebSocketRequestResponsePair = undefined;

        let called = false;
        const scheduler = new SchedulerDO(
            baseState(() => {
                called = true;
            }),
            {},
        );

        expect(scheduler).toBeInstanceOf(SchedulerDO);
        expect(called).toBe(false);
    });
});
