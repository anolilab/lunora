import { describe, expect, it, vi } from "vitest";

import type { PokeBuffer, ShapeSubscriptionState } from "../src/shape-state";
import { commitPokeSlice, emitShapeRows, PokeAssembler } from "../src/shape-state";
import type { RowOp, ServerPokeEndMessage, ServerPokePartMessage, ServerPokeStartMessage } from "../src/types";

const shape = (overrides: Partial<ShapeSubscriptionState> = {}): ShapeSubscriptionState => {
    return {
        args: undefined,
        callbacks: new Set(),
        errorCallbacks: new Set(),
        id: "s1",
        name: "todos:list",
        rows: new Map(),
        shardKey: undefined,
        wireArgs: undefined,
        ...overrides,
    };
};

const start = (pokeId: string, extra: Partial<ServerPokeStartMessage> = {}): ServerPokeStartMessage => {
    return { pokeId, type: "pokeStart", ...extra };
};

const part = (pokeId: string, extra: Partial<ServerPokePartMessage> = {}): ServerPokePartMessage => {
    return {
        pokeId,
        rowsPatch: [],
        shapeId: "s1",
        type: "pokePart",
        ...extra,
    };
};

const end = (pokeId: string, extra: Partial<ServerPokeEndMessage> = {}): ServerPokeEndMessage => {
    return { pokeId, type: "pokeEnd", ...extra };
};

const upsert = (key: string, value: Record<string, unknown>): RowOp => {
    return { key, op: "insert", table: "todos", value };
};

/** A buffer as `PokeAssembler.end` hands it back, built directly for the commit tests. */
const buffer = (overrides: Partial<PokeBuffer> = {}): PokeBuffer => {
    return {
        baseCheckpoint: undefined,
        bases: new Map(),
        epoch: undefined,
        lastMutationId: new Map(),
        parts: new Map(),
        resets: new Set(),
        undecodable: new Map(),
        ...overrides,
    };
};

describe("pokeAssembler", () => {
    it("assembles a start, a part and an end into one buffer, then forgets it", () => {
        expect.assertions(3);

        const assembler = new PokeAssembler(8);

        assembler.start(undefined, start("p1", { baseCheckpoint: 4, epoch: "e1" }));
        assembler.part(undefined, part("p1", { rowsPatch: [upsert("a", { id: "a" })] }));

        const assembled = assembler.end(undefined, "p1");

        expect(assembled?.epoch).toBe("e1");
        expect(assembled?.parts.get("s1")).toStrictEqual([upsert("a", { id: "a" })]);
        expect(assembler.end(undefined, "p1")).toBeUndefined();
    });

    it("ignores a part for a poke it never saw, without creating a buffer", () => {
        expect.assertions(2);

        const assembler = new PokeAssembler(8);

        assembler.part(undefined, part("ghost", { rowsPatch: [upsert("a", { id: "a" })] }));

        expect(assembler.end(undefined, "ghost")).toBeUndefined();
        expect(assembler.end(undefined, "ghost")).toBeUndefined();
    });

    it("keeps two shards' pokes with the same pokeId apart", () => {
        expect.assertions(2);

        const assembler = new PokeAssembler(8);

        assembler.start("tenant-a", start("p1", { epoch: "a" }));
        assembler.start("tenant-b", start("p1", { epoch: "b" }));

        expect(assembler.end("tenant-a", "p1")?.epoch).toBe("a");
        expect(assembler.end("tenant-b", "p1")?.epoch).toBe("b");
    });

    it("evicts the oldest buffer once the cap is reached", () => {
        expect.assertions(3);

        const assembler = new PokeAssembler(2);

        assembler.start(undefined, start("old"));
        assembler.start(undefined, start("middle"));
        assembler.start(undefined, start("new"));

        expect(assembler.end(undefined, "old")).toBeUndefined();
        expect(assembler.end(undefined, "middle")).toBeDefined();
        expect(assembler.end(undefined, "new")).toBeDefined();
    });

    it("records a refused row as undecodable and buffers nothing for that shape", () => {
        expect.assertions(3);

        const assembler = new PokeAssembler(8);

        assembler.start(undefined, start("p1"));
        assembler.part(
            undefined,
            part("p1", {
                rowsPatch: [
                    { key: "a", op: "insert", table: "todos", value: ["$lunora.wire$", "bigint", "not-a-number"] as unknown as Record<string, unknown> },
                ],
            }),
        );

        const assembled = assembler.end(undefined, "p1");

        expect(assembled?.undecodable.has("s1")).toBe(true);
        expect(assembled?.parts.has("s1")).toBe(false);
        expect(assembled?.bases.has("s1")).toBe(false);
    });

    it("carries a part's watermark and reset flag into the buffer", () => {
        expect.assertions(2);

        const assembler = new PokeAssembler(8);

        assembler.start(undefined, start("p1", { baseCheckpoint: 9 }));
        assembler.part(undefined, part("p1", { lastMutationId: 42, reset: true }));

        const assembled = assembler.end(undefined, "p1");

        expect(assembled?.lastMutationId.get("s1")).toBe(42);
        expect(assembled?.resets.has("s1")).toBe(true);
    });

    it("clear() drops every buffer", () => {
        expect.assertions(1);

        const assembler = new PokeAssembler(8);

        assembler.start(undefined, start("p1"));
        assembler.clear();

        expect(assembler.end(undefined, "p1")).toBeUndefined();
    });
});

describe("commitPokeSlice", () => {
    it("applies the buffered ops and advances the cursor, epoch and watermark", () => {
        expect.assertions(4);

        const state = shape({ serverCursor: 3, serverEpoch: "e1" });
        const assembled = buffer({ epoch: "e1", lastMutationId: new Map([["s1", 7]]), parts: new Map([["s1", [upsert("a", { id: "a" })]]]) });

        expect(commitPokeSlice(state, assembled, end("p1", { checkpoint: 5, epoch: "e1" }))).toBe("applied");
        expect(state.rows.get("a")).toStrictEqual({ id: "a" });
        expect(state.serverCursor).toBe(5);
        expect(state.lastMutationId).toBe(7);
    });

    it("re-seeds on an epoch fork and does not splice the ops", () => {
        expect.assertions(4);

        const state = shape({ rows: new Map([["old", { id: "old" }]]), serverCursor: 3, serverEpoch: "e1" });
        const assembled = buffer({ epoch: "e2", parts: new Map([["s1", [upsert("a", { id: "a" })]]]) });

        expect(commitPokeSlice(state, assembled, end("p1", { checkpoint: 5, epoch: "e2" }))).toBe("reseed");
        expect(state.rows.size).toBe(0);
        expect(state.serverCursor).toBeUndefined();
        expect(state.serverEpoch).toBeUndefined();
    });

    it("re-seeds when the part's base is not the cursor the view is at", () => {
        expect.assertions(2);

        const state = shape({ rows: new Map([["old", { id: "old" }]]), serverCursor: 3 });
        const assembled = buffer({ bases: new Map([["s1", 9]]), parts: new Map([["s1", [upsert("a", { id: "a" })]]]) });

        expect(commitPokeSlice(state, assembled, end("p1", { checkpoint: 10 }))).toBe("reseed");
        expect(state.rows.has("old")).toBe(false);
    });

    it("lets a reset part win over an epoch fork and replace the whole view", () => {
        expect.assertions(3);

        const state = shape({ rows: new Map([["stale", { id: "stale" }]]), serverCursor: 3, serverEpoch: "e1" });
        const assembled = buffer({ epoch: "e2", resets: new Set(["s1"]), parts: new Map([["s1", [upsert("a", { id: "a" })]]]) });

        expect(commitPokeSlice(state, assembled, end("p1", { checkpoint: 6, epoch: "e2" }))).toBe("applied");
        expect(state.rows.has("stale")).toBe(false);
        expect(state.rows.get("a")).toStrictEqual({ id: "a" });
    });

    it("lets a reset part win over a base divergence too", () => {
        expect.assertions(2);

        const state = shape({ rows: new Map([["stale", { id: "stale" }]]), serverCursor: 3 });
        const assembled = buffer({ bases: new Map([["s1", 9]]), resets: new Set(["s1"]), parts: new Map([["s1", [upsert("a", { id: "a" })]]]) });

        expect(commitPokeSlice(state, assembled, end("p1", { checkpoint: 10 }))).toBe("applied");
        expect(state.rows.has("stale")).toBe(false);
    });
});

describe("emitShapeRows", () => {
    it("hands every callback the current rows, in insertion order", () => {
        expect.assertions(2);

        const first = vi.fn<(rows: Record<string, unknown>[]) => void>();
        const second = vi.fn<(rows: Record<string, unknown>[]) => void>();
        const state = shape({
            callbacks: new Set([first, second]),
            rows: new Map([
                ["a", { _id: "a" }],
                ["b", { _id: "b" }],
            ]),
        });

        emitShapeRows(state);

        expect(first).toHaveBeenCalledWith([{ _id: "a" }, { _id: "b" }]);
        expect(second).toHaveBeenCalledWith([{ _id: "a" }, { _id: "b" }]);
    });

    it("keeps calling the other callbacks when one throws", () => {
        expect.assertions(1);

        const survivor = vi.fn<(rows: Record<string, unknown>[]) => void>();
        const state = shape({
            callbacks: new Set([
                () => {
                    throw new Error("subscriber bug");
                },
                survivor,
            ]),
        });

        emitShapeRows(state);

        expect(survivor).toHaveBeenCalledTimes(1);
    });
});
