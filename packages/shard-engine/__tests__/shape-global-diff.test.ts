import { describe, expect, it } from "vitest";

import { decodeWire } from "../../../shared/wire-codec";
import type { ShapeRow } from "../src/ctx-db-shapes";
import { buildPokeFrames, diffGlobalMembership, encodeRowsPatch, projectColumns } from "../src/shape-global-diff";

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

        // `toEqual` (not `toStrictEqual`): the projection target is a
        // null-prototype object (hardening against a `__proto__` column), so a
        // plain-object expectation differs by prototype under strict equality.
        expect(projectColumns({ _creationTime: 9, _id: "t1", hidden: "x", label: "a" }, ["label"])).toEqual({
            _creationTime: 9,
            _id: "t1",
            label: "a",
        });
    });

    it("copies a `__proto__` column as a plain data field without polluting the prototype", () => {
        expect.assertions(2);

        // `JSON.parse` yields a real OWN `__proto__` property (a literal's
        // `__proto__:` would set the prototype instead) — the adversarial input.
        const payload = JSON.parse('{"__proto__":{"polluted":true},"_id":"t1"}') as Record<string, unknown>;
        const projected = projectColumns(payload, ["__proto__"]);

        // The dangerous key is an own data property, and nothing leaked onto Object.prototype.
        expect(Object.hasOwn(projected, "__proto__")).toBe(true);
        expect(({} as Record<string, unknown>).polluted).toBeUndefined();
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

describe("relay poke wire fidelity (encodeRowsPatch + preEncoded)", () => {
    // Regression: a relay-promoted shape's live poke crosses the owner→relay
    // `JSON.stringify` hub hop as a raw structured value. Before the fix, a
    // `bytes`/`bigint` column threw (bigint) or truncated to `{}` (ArrayBuffer)
    // at that hop, then the relay re-framed the corrupted value. The owner now
    // `encodeRowsPatch`es before the hop and the relay re-frames with
    // `preEncoded`, so the value survives end-to-end.
    it("carries bigint + bytes through owner-encode → hub JSON hop → relay preEncoded reframe", () => {
        expect.assertions(3);

        const bytes = new Uint8Array([1, 2, 3, 255]).buffer;
        const rawRowsPatch = [{ key: "t1", op: "insert" as const, table: "coins", value: { _id: "t1", balance: 42n, blob: bytes } }];

        // Owner side: encode before the poke crosses the hub, then simulate the
        // `requestRelayMessage` `JSON.stringify` / relay-side `JSON.parse`.
        const encoded = encodeRowsPatch(rawRowsPatch);

        expect(() => JSON.stringify({ rowsPatch: encoded })).not.toThrow(); // raw bigint would throw here

        // Deliberately round-trip through JSON (NOT structuredClone) — that IS the
        // owner→relay hub hop this regression guards; structuredClone would preserve
        // bigint/bytes and defeat the test.
        // eslint-disable-next-line unicorn/prefer-structured-clone -- must exercise the real JSON transport hop, not a structured clone
        const forwarded = JSON.parse(JSON.stringify({ rowsPatch: encoded })) as { rowsPatch: typeof encoded };

        // Relay side: re-frame WITHOUT a second encode.
        const frames =
            forwarded.rowsPatch.length > 0
                ? buildPokeFrames(
                      [{ rowsPatch: forwarded.rowsPatch, shapeId: "s1" }],
                      { baseCheckpoint: undefined, checkpoint: 1, epoch: "e1", lastMutationId: undefined, pokeId: "p1" },
                      { preEncoded: true },
                  )
                : [];

        const pokePart = frames
            .map((frame) => JSON.parse(frame) as { rowsPatch?: { value?: unknown }[]; type: string })
            .find((frame) => frame.type === "pokePart");
        // Client decode of the delivered value round-trips to the real bigint + bytes.
        const decoded = decodeWire(pokePart?.rowsPatch?.[0]?.value) as { balance: bigint; blob: ArrayBuffer };

        expect(decoded.balance).toBe(42n);
        expect(new Uint8Array(decoded.blob)).toStrictEqual(new Uint8Array([1, 2, 3, 255]));
    });
});
