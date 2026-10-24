/* eslint-disable no-secrets/no-secrets -- the flagged strings are the `peekActiveQuerySnapshot` method name, not credentials */
import { describe, expect, it, vi } from "vitest";

import { LunoraClient } from "../src/lunora-client";
import createSnapshotPrecondition from "../src/snapshot-precondition";
import type { FunctionReference } from "../src/types";

/**
 * `createSnapshotPrecondition` is the staleness guard that decides whether a queued
 * offline mutation is dropped on replay: it snapshots a live query's value at call
 * time and, on replay, re-reads it via {@link LunoraClient.peekActiveQuerySnapshot} to
 * decide whether it still matches. The comparison only runs when a live subscription
 * backed BOTH reads — an unobserved query (no subscription) is treated as not-stale
 * rather than as a value that appeared or disappeared. These tests cover that branch
 * directly against that one-method stub seam.
 */

const fnRef = (ref: string): FunctionReference => {
    return { __lunoraRef: ref };
};

type Snapshot = { answered: boolean; present: boolean; value: unknown };

/** Stub exposing only `peekActiveQuerySnapshot` — the one client method this module calls. */
const stubClient = (snapshot: Snapshot, current: Snapshot): LunoraClient => {
    const peekActiveQuerySnapshot = vi.fn<LunoraClient["peekActiveQuerySnapshot"]>().mockReturnValueOnce(snapshot).mockReturnValueOnce(current);

    return { peekActiveQuerySnapshot } as unknown as LunoraClient;
};

describe("createSnapshotPrecondition", () => {
    it("no subscription at either read -> true (nothing to compare)", () => {
        expect.assertions(1);

        const client = stubClient({ answered: false, present: false, value: undefined }, { answered: false, present: false, value: undefined });
        const precondition = createSnapshotPrecondition(client, fnRef("todos:list"), {});

        expect(precondition()).toBe(true);
    });

    it("subscription live at snapshot, absent at replay -> true (unmounted, not a conflict)", () => {
        expect.assertions(1);

        const client = stubClient({ answered: true, present: true, value: { id: 1 } }, { answered: false, present: false, value: undefined });
        const precondition = createSnapshotPrecondition(client, fnRef("todos:list"), {});

        expect(precondition()).toBe(true);
    });

    it("subscription absent at snapshot, live at replay -> true", () => {
        expect.assertions(1);

        const client = stubClient({ answered: false, present: false, value: undefined }, { answered: true, present: true, value: { id: 1 } });
        const precondition = createSnapshotPrecondition(client, fnRef("todos:list"), {});

        expect(precondition()).toBe(true);
    });

    it("both live, value changed -> false", () => {
        expect.assertions(1);

        const client = stubClient(
            { answered: true, present: true, value: { id: 1, text: "a" } },
            { answered: true, present: true, value: { id: 1, text: "b" } },
        );
        const precondition = createSnapshotPrecondition(client, fnRef("todos:list"), {});

        expect(precondition()).toBe(false);
    });

    it("both live, current subscription blanked and unanswered -> true (no evidence)", () => {
        expect.assertions(1);

        const client = stubClient({ answered: true, present: true, value: { id: 1 } }, { answered: false, present: true, value: undefined });
        const precondition = createSnapshotPrecondition(client, fnRef("todos:list"), {});

        expect(precondition()).toBe(true);
    });

    it("both live, value unchanged -> true", () => {
        expect.assertions(1);

        const client = stubClient(
            { answered: true, present: true, value: { id: 1, text: "a" } },
            { answered: true, present: true, value: { id: 1, text: "a" } },
        );
        const precondition = createSnapshotPrecondition(client, fnRef("todos:list"), {});

        expect(precondition()).toBe(true);
    });

    it("both live, value genuinely became undefined while subscribed -> false (still a conflict)", () => {
        expect.assertions(1);

        const client = stubClient({ answered: true, present: true, value: { id: 1 } }, { answered: true, present: true, value: undefined });
        const precondition = createSnapshotPrecondition(client, fnRef("todos:list"), {});

        expect(precondition()).toBe(false);
    });
});

/**
 * `client.snapshotPrecondition(...)` is the documented ergonomic entry point —
 * it is what the module function's own example tells users to call. It must
 * therefore answer identically; a second hand-written copy of the comparison
 * behind it is how the "unmounted component drops the queued write" bug
 * survived the module-level fix.
 */
describe("lunoraClient.snapshotPrecondition", () => {
    /** A real `LunoraClient` prototype method bound to a stub with only the peek it uses. */
    const boundMethod = (snapshot: Snapshot, current: Snapshot): (() => boolean) => {
        const client = stubClient(snapshot, current);

        return LunoraClient.prototype.snapshotPrecondition.call(client, fnRef("todos:list"), {});
    };

    it("subscription live at snapshot, absent at replay -> true (the originating component unmounted)", () => {
        expect.assertions(1);

        expect(boundMethod({ answered: true, present: true, value: { id: 1 } }, { answered: false, present: false, value: undefined })()).toBe(true);
    });

    it("subscription absent at snapshot, live at replay -> true", () => {
        expect.assertions(1);

        expect(boundMethod({ answered: false, present: false, value: undefined }, { answered: true, present: true, value: { id: 1 } })()).toBe(true);
    });

    it("both live, value changed -> false", () => {
        expect.assertions(1);

        expect(
            boundMethod({ answered: true, present: true, value: { id: 1, text: "a" } }, { answered: true, present: true, value: { id: 1, text: "b" } })(),
        ).toBe(false);
    });

    it("both live, value unchanged -> true", () => {
        expect.assertions(1);

        expect(
            boundMethod({ answered: true, present: true, value: { id: 1, text: "a" } }, { answered: true, present: true, value: { id: 1, text: "a" } })(),
        ).toBe(true);
    });
});

/**
 * A bearer sign-in on a transport that presents it on the upgrade reconnects every socket cold, which blanks each
 * subscription's value until the new socket answers. The offline queue replays on that socket's `open`, before
 * the answers land, so a blank must read as "no evidence", not as a changed value.
 */
describe("snapshotPrecondition across a cold reconnect", () => {
    interface Frames {
        open: () => void;
        receive: (payload: unknown) => void;
        sent: Record<string, unknown>[];
    }

    const sockets: Frames[] = [];

    class MockSocket {
        public readyState = 0;

        private readonly listeners = new Map<string, ((event?: unknown) => void)[]>();

        private readonly sent: Record<string, unknown>[] = [];

        public constructor(public readonly url: string) {
            sockets.push({
                open: () => {
                    this.readyState = 1;
                    this.emit("open");
                },
                receive: (payload) => {
                    this.emit("message", { data: JSON.stringify(payload) });
                },
                sent: this.sent,
            });
        }

        public addEventListener(type: string, listener: (event?: unknown) => void): void {
            this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
        }

        public close(): void {
            this.readyState = 3;
            this.emit("close", { code: 1000 });
        }

        public removeEventListener(type: string): void {
            this.listeners.delete(type);
        }

        public send(raw: string): void {
            this.sent.push(JSON.parse(raw) as Record<string, unknown>);
        }

        private emit(type: string, event?: unknown): void {
            for (const listener of this.listeners.get(type) ?? []) {
                listener(event);
            }
        }
    }

    it("treats a subscription blanked by the reconnect as undecided, not as a changed value", () => {
        expect.assertions(2);

        sockets.length = 0;

        const client = new LunoraClient({
            authTokenOnUpgrade: true,
            fetch: vi.fn<typeof fetch>(async () => Response.json({}, { status: 200 })),
            heartbeatIntervalMs: 0,
            persistence: false,
            url: "http://app.test",
            WebSocket: MockSocket as unknown as typeof WebSocket,
        });

        client.subscribe(fnRef("todos.list"), {}, () => {});

        const socket = sockets.at(-1);

        socket?.open();
        socket?.receive({ cursor: 1, data: [{ _id: "t1" }], id: socket.sent.find((message) => message.type === "subscribe")?.id, type: "data" });

        const precondition = client.snapshotPrecondition(fnRef("todos.list"), {});

        expect(precondition()).toBe(true);

        client.setAuthToken("tok-a", "user-a");

        expect(precondition()).toBe(true);

        client.close();
    });
});
