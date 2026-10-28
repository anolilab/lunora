import { encodeWire } from "@lunora/wire";
import { describe, expect, it } from "vitest";

import { resolveDataPayload, UNMERGEABLE_DELTA } from "../src/delta-merge";
import type { ServerDataMessage } from "../src/types";

const snapshot = (data: unknown): ServerDataMessage => {
    return { data, id: "s1", type: "data" };
};

const deltaFrame = (delta: unknown): ServerDataMessage => {
    return { delta, id: "s1", type: "delta" };
};

describe("resolveDataPayload", () => {
    it("wire-decodes a snapshot so a bigint column arrives as a real value", () => {
        expect.assertions(1);

        expect(resolveDataPayload(snapshot(encodeWire({ total: 42n })), undefined)).toStrictEqual({ total: 42n });
    });

    it("returns a row delta unchanged when there is no base to merge into", () => {
        expect.assertions(1);

        const delta = { key: "a", op: "insert", row: { _id: "a" }, table: "todos" };

        expect(resolveDataPayload(deltaFrame(delta), undefined)).toStrictEqual(delta);
    });

    it("splices a row delta into a list base", () => {
        expect.assertions(1);

        const base = [{ _id: "a", title: "one" }];
        const delta = { key: "b", op: "insert", row: { _id: "b", title: "two" }, table: "todos" };

        expect(resolveDataPayload(deltaFrame(delta), base)).toStrictEqual([
            { _id: "a", title: "one" },
            { _id: "b", title: "two" },
        ]);
    });

    it("returns the sentinel for a row delta it cannot splice into the base", () => {
        expect.assertions(1);

        // A scalar base is not a list. Publishing the raw row envelope over it would
        // never be reconciled, so the caller must re-snapshot instead.
        const delta = { key: "b", op: "insert", row: { _id: "b" }, table: "todos" };

        expect(resolveDataPayload(deltaFrame(delta), 5)).toBe(UNMERGEABLE_DELTA);
    });

    it("replaces the base with an opaque payload that is not a row delta", () => {
        expect.assertions(1);

        expect(resolveDataPayload(deltaFrame({ count: 3 }), [{ _id: "a" }])).toStrictEqual({ count: 3 });
    });
});
