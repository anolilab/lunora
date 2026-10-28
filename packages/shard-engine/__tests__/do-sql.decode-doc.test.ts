import { WIRE_TAG } from "@lunora/wire";
import { describe, expect, it } from "vitest";

import { decodeDocJson, encodeDocJson } from "../src/do-sql";

describe("decodeDocJson", () => {
    it("revives wire-tagged leaves, top-level and nested", () => {
        expect.assertions(1);

        const document = { at: new Date(5), n: 7n, nested: { bytes: new Uint8Array([1, 2]), when: new Date(9) } };

        expect(decodeDocJson(encodeDocJson(document))).toStrictEqual(document);
    });

    it("returns a plain row as parsed", () => {
        expect.assertions(1);

        const document = { list: [1, "two", { three: null }], name: "plain" };

        expect(decodeDocJson(encodeDocJson(document))).toStrictEqual(document);
    });

    it("keeps a string that merely contains the tag text", () => {
        expect.assertions(1);

        const document = { label: `${WIRE_TAG} is just text`, pair: [WIRE_TAG, "not-a-kind"] };

        expect(decodeDocJson(encodeDocJson(document))).toStrictEqual(document);
    });

    it("revives a frame whose tag is written with JSON unicode escapes", () => {
        expect.assertions(1);

        const raw = String.raw`{"n":["\u0024lunora.wire$","bigint","1"]}`;

        expect(decodeDocJson(raw)).toStrictEqual({ n: 1n });
    });
});
