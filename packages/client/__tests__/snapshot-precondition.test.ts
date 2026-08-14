import { describe, expect, it, vi } from "vitest";

import type { LunoraClient } from "../src/lunora-client";
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

type Snapshot = { present: boolean; value: unknown };

/** Stub exposing only `peekActiveQuerySnapshot` — the one client method this module calls. */
const stubClient = (snapshot: Snapshot, current: Snapshot): LunoraClient => {
    const peekActiveQuerySnapshot = vi.fn<LunoraClient["peekActiveQuerySnapshot"]>().mockReturnValueOnce(snapshot).mockReturnValueOnce(current);

    return { peekActiveQuerySnapshot } as unknown as LunoraClient;
};

describe("createSnapshotPrecondition", () => {
    it("no subscription at either read -> true (nothing to compare)", () => {
        expect.assertions(1);

        const client = stubClient({ present: false, value: undefined }, { present: false, value: undefined });
        const precondition = createSnapshotPrecondition(client, fnRef("todos:list"), {});

        expect(precondition()).toBe(true);
    });

    it("subscription live at snapshot, absent at replay -> true (unmounted, not a conflict)", () => {
        expect.assertions(1);

        const client = stubClient({ present: true, value: { id: 1 } }, { present: false, value: undefined });
        const precondition = createSnapshotPrecondition(client, fnRef("todos:list"), {});

        expect(precondition()).toBe(true);
    });

    it("subscription absent at snapshot, live at replay -> true", () => {
        expect.assertions(1);

        const client = stubClient({ present: false, value: undefined }, { present: true, value: { id: 1 } });
        const precondition = createSnapshotPrecondition(client, fnRef("todos:list"), {});

        expect(precondition()).toBe(true);
    });

    it("both live, value changed -> false", () => {
        expect.assertions(1);

        const client = stubClient({ present: true, value: { id: 1, text: "a" } }, { present: true, value: { id: 1, text: "b" } });
        const precondition = createSnapshotPrecondition(client, fnRef("todos:list"), {});

        expect(precondition()).toBe(false);
    });

    it("both live, value unchanged -> true", () => {
        expect.assertions(1);

        const client = stubClient({ present: true, value: { id: 1, text: "a" } }, { present: true, value: { id: 1, text: "a" } });
        const precondition = createSnapshotPrecondition(client, fnRef("todos:list"), {});

        expect(precondition()).toBe(true);
    });

    it("both live, value genuinely became undefined while subscribed -> false (still a conflict)", () => {
        expect.assertions(1);

        const client = stubClient({ present: true, value: { id: 1 } }, { present: true, value: undefined });
        const precondition = createSnapshotPrecondition(client, fnRef("todos:list"), {});

        expect(precondition()).toBe(false);
    });
});
