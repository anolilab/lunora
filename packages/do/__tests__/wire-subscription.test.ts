import { buildPokeFrames, diffGlobalMembership, subscriptionListDeltas } from "@lunora/shard-engine";
import { describe, expect, it } from "vitest";

import { decodeWire, encodeWire } from "../../../shared/wire-codec";

/** Parse a wire frame body and wire-decode it, mirroring the client. */
const decodeFrame = (frame: string): Record<string, unknown> => decodeWire(JSON.parse(frame)) as Record<string, unknown>;

describe("subscription list deltas carry bytes/bigint", () => {
    it("encodes a changed bigint/bytes row into a decodable update frame", () => {
        expect.assertions(2);

        // The baseline is the server's wire-encoded snapshot (see pushSubscriptionData).
        const previousJson = JSON.stringify(encodeWire([{ _id: "a", count: 1n }]));
        const next = [{ _id: "a", blob: new Uint8Array([7, 8]).buffer, count: 2n }];
        const frames: string[] = [];

        // Pre-change this would have thrown on the bigint row.
        const deltas = subscriptionListDeltas(previousJson, next, "counters", frames);

        expect(deltas).toStrictEqual([{ key: "a", op: "update", row: next[0], table: "counters" }]);

        const decoded = decodeFrame(frames[0] as string);

        expect(decoded.row).toStrictEqual({ _id: "a", blob: new Uint8Array([7, 8]).buffer, count: 2n });
    });
});

describe("shape pokes carry bytes/bigint", () => {
    it("wire-encodes a rowsPatch value into a decodable pokePart", () => {
        expect.assertions(1);

        const frames = buildPokeFrames([{ rowsPatch: [{ key: "t1", op: "insert", table: "things", value: { _id: "t1", size: 42n } }], shapeId: "s1" }], {
            baseCheckpoint: undefined,
            checkpoint: 5,
            epoch: undefined,
            lastMutationId: undefined,
            pokeId: "p1",
        });

        // frames = [pokeStart, pokePart, pokeEnd]
        const part = decodeFrame(frames[1] as string);
        const [first] = part.rowsPatch as { value: Record<string, unknown> }[];

        expect(first?.value).toStrictEqual({ _id: "t1", size: 42n });
    });
});

describe("global membership diff tolerates bytes/bigint", () => {
    it("does not throw fingerprinting a bigint column and emits the insert", () => {
        expect.assertions(1);

        const { rowsPatch } = diffGlobalMembership([{ doc: { _id: "g1", version: 9_007_199_254_740_993n }, id: "g1" }], new Map(), { table: "docs" });

        expect(rowsPatch).toStrictEqual([{ key: "g1", op: "insert", table: "docs", value: { _id: "g1", version: 9_007_199_254_740_993n } }]);
    });
});
