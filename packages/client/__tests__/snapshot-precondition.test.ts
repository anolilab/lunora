import { describe, expect, it, vi } from "vitest";

import type { LunoraClient } from "../src/lunora-client";
import createSnapshotPrecondition from "../src/snapshot-precondition";
import type { FunctionReference } from "../src/types";

/**
 * `createSnapshotPrecondition` is the staleness guard that decides whether a queued
 * offline mutation is dropped on replay: it snapshots a live query's value at call
 * time and, on replay, re-reads it via {@link LunoraClient.peekActiveQueryValue} to
 * decide whether it still matches. These tests cover the four branches at
 * `snapshot-precondition.ts:32-44` directly against that one-method stub seam.
 */

const fnRef = (ref: string): FunctionReference => {
    return { __lunoraRef: ref };
};

/** Stub exposing only `peekActiveQueryValue` — the one client method this module calls. */
const stubClient = (snapshotValue: unknown, currentValue: unknown): LunoraClient => {
    const peekActiveQueryValue = vi.fn<LunoraClient["peekActiveQueryValue"]>().mockReturnValueOnce(snapshotValue).mockReturnValueOnce(currentValue);

    return { peekActiveQueryValue } as unknown as LunoraClient;
};

describe("createSnapshotPrecondition", () => {
    it("both undefined -> true (no snapshot taken and no value now)", () => {
        expect.assertions(1);

        const client = stubClient(undefined, undefined);
        const precondition = createSnapshotPrecondition(client, fnRef("todos:list"), {});

        expect(precondition()).toBe(true);
    });

    it("snapshot undefined, current present -> false (the value appeared)", () => {
        expect.assertions(1);

        const client = stubClient(undefined, { id: 1 });
        const precondition = createSnapshotPrecondition(client, fnRef("todos:list"), {});

        expect(precondition()).toBe(false);
    });

    it("snapshot present, current undefined -> false (the value disappeared)", () => {
        expect.assertions(1);

        const client = stubClient({ id: 1 }, undefined);
        const precondition = createSnapshotPrecondition(client, fnRef("todos:list"), {});

        expect(precondition()).toBe(false);
    });

    it("both present and stableWireKey-equal -> true", () => {
        expect.assertions(1);

        const client = stubClient({ id: 1, text: "a" }, { id: 1, text: "a" });
        const precondition = createSnapshotPrecondition(client, fnRef("todos:list"), {});

        expect(precondition()).toBe(true);
    });

    it("both present and different -> false", () => {
        expect.assertions(1);

        const client = stubClient({ id: 1, text: "a" }, { id: 1, text: "b" });
        const precondition = createSnapshotPrecondition(client, fnRef("todos:list"), {});

        expect(precondition()).toBe(false);
    });
});
