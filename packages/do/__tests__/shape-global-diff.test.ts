import { describe, expect, it } from "vitest";

import type { ShapeRow } from "../src/ctx-db-shapes";
import { buildPokeFrames, diffGlobalMembership, projectColumns } from "../src/shape-global-diff";

const row = (id: string, doc: Record<string, unknown>): ShapeRow => {
    return { doc, id };
};

describe(diffGlobalMembership, () => {
    it("treats a diff against an empty baseline as an all-insert seed", () => {
        expect.assertions(2);

        const { next, rowsPatch } = diffGlobalMembership([row("t1", { _id: "t1", label: "a" }), row("t2", { _id: "t2", label: "b" })], new Map(), {
            table: "things",
        });

        expect(rowsPatch).toStrictEqual([
            { key: "t1", op: "insert", table: "things", value: { _id: "t1", label: "a" } },
            { key: "t2", op: "insert", table: "things", value: { _id: "t2", label: "b" } },
        ]);
        // The returned snapshot is the baseline the next tick diffs from.
        expect([...next]).toStrictEqual([
            ["t1", JSON.stringify({ _id: "t1", label: "a" })],
            ["t2", JSON.stringify({ _id: "t2", label: "b" })],
        ]);
    });

    it("emits insert / update / delete for the delta and skips unchanged rows", () => {
        expect.assertions(1);

        const previous = new Map<string, string>([
            ["t1", JSON.stringify({ _id: "t1", label: "a" })],
            ["t2", JSON.stringify({ _id: "t2", label: "b" })],
            ["t4", JSON.stringify({ _id: "t4", label: "d" })],
        ]);

        // t1 unchanged, t2 changed, t3 new, t4 vanished.
        const { rowsPatch } = diffGlobalMembership(
            [row("t1", { _id: "t1", label: "a" }), row("t2", { _id: "t2", label: "b2" }), row("t3", { _id: "t3", label: "c" })],
            previous,
            { table: "things" },
        );

        expect(rowsPatch).toStrictEqual([
            { key: "t2", op: "update", table: "things", value: { _id: "t2", label: "b2" } },
            { key: "t3", op: "insert", table: "things", value: { _id: "t3", label: "c" } },
            { key: "t4", op: "delete", table: "things" },
        ]);
    });

    it("returns an empty patch when membership is unchanged", () => {
        expect.assertions(1);

        const previous = new Map<string, string>([["t1", JSON.stringify({ _id: "t1", label: "a" })]]);

        const { rowsPatch } = diffGlobalMembership([row("t1", { _id: "t1", label: "a" })], previous, { table: "things" });

        expect(rowsPatch).toStrictEqual([]);
    });

    it("diffs projected values so an out-of-column change is invisible", () => {
        expect.assertions(1);

        // Only `label` is projected; `secret` is dropped, so changing it alone is a no-op.
        const previous = new Map<string, string>([["t1", JSON.stringify({ _id: "t1", label: "a" })]]);

        const { rowsPatch } = diffGlobalMembership([row("t1", { _id: "t1", label: "a", secret: "changed" })], previous, {
            columns: ["label"],
            table: "things",
        });

        expect(rowsPatch).toStrictEqual([]);
    });
});

describe(projectColumns, () => {
    it("ships the full document verbatim when no columns are declared", () => {
        expect.assertions(1);

        expect(projectColumns({ _id: "t1", a: 1, b: 2 }, undefined)).toStrictEqual({ _id: "t1", a: 1, b: 2 });
    });

    it("retains _id / _creationTime alongside the allow-listed columns", () => {
        expect.assertions(1);

        expect(projectColumns({ _creationTime: 9, _id: "t1", hidden: "x", label: "a" }, ["label"])).toStrictEqual({
            _creationTime: 9,
            _id: "t1",
            label: "a",
        });
    });
});

describe(buildPokeFrames, () => {
    it("frames a poke as pokeStart, one pokePart per shape slice, then pokeEnd", () => {
        expect.assertions(1);

        const frames = buildPokeFrames(
            [
                { rowsPatch: [{ key: "t1", op: "insert", table: "things", value: { _id: "t1" } }], shapeId: "s1" },
                { rowsPatch: [{ key: "u1", op: "delete", table: "others" }], shapeId: "s2" },
            ],
            { baseCheckpoint: 3, checkpoint: 7, epoch: "e1", lastMutationId: undefined, pokeId: "poke-1" },
        );

        expect(frames.map((frame) => JSON.parse(frame) as unknown)).toStrictEqual([
            { baseCheckpoint: 3, epoch: "e1", pokeId: "poke-1", type: "pokeStart" },
            { pokeId: "poke-1", rowsPatch: [{ key: "t1", op: "insert", table: "things", value: { _id: "t1" } }], shapeId: "s1", type: "pokePart" },
            { pokeId: "poke-1", rowsPatch: [{ key: "u1", op: "delete", table: "others" }], shapeId: "s2", type: "pokePart" },
            { checkpoint: 7, epoch: "e1", pokeId: "poke-1", type: "pokeEnd" },
        ]);
    });

    it("stamps the client watermark as lastMutationId on every pokePart when supplied", () => {
        expect.assertions(1);

        const frames = buildPokeFrames([{ rowsPatch: [{ key: "t1", op: "insert", table: "things", value: { _id: "t1" } }], shapeId: "s1" }], {
            baseCheckpoint: undefined,
            checkpoint: 7,
            epoch: "e1",
            lastMutationId: 42,
            pokeId: "poke-1",
        });

        expect(frames.map((frame) => JSON.parse(frame) as unknown)).toStrictEqual([
            { epoch: "e1", pokeId: "poke-1", type: "pokeStart" },
            {
                lastMutationId: 42,
                pokeId: "poke-1",
                rowsPatch: [{ key: "t1", op: "insert", table: "things", value: { _id: "t1" } }],
                shapeId: "s1",
                type: "pokePart",
            },
            { checkpoint: 7, epoch: "e1", pokeId: "poke-1", type: "pokeEnd" },
        ]);
    });
});
