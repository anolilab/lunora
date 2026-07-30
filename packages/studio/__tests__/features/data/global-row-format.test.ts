import { describe, expect, it } from "vitest";

import { chipValue, rowKey } from "../../../src/features/data/global-row-format";

describe("rowKey", () => {
    it("prefers the document's own primary key", () => {
        expect.assertions(2);

        expect(rowKey({ _id: "doc_7", name: "ada" }, 3)).toBe("doc_7");
        // A numeric `_id` from a SQL-shaped global table is still an identity.
        expect(rowKey({ _id: 42 }, 3)).toBe("42");
    });

    it("falls back to the position only when there is no usable id", () => {
        expect.assertions(4);

        // Position is a last resort: it makes a row's key change when the page
        // re-sorts, so it must not win over a real id.
        expect(rowKey({ name: "ada" }, 0)).toBe("row-0");
        expect(rowKey({ _id: null }, 1)).toBe("row-1");
        expect(rowKey({ _id: undefined }, 2)).toBe("row-2");
        expect(rowKey({ _id: { nested: true } }, 3)).toBe("row-3");
    });
});

describe("chipValue", () => {
    it("distinguishes NULL and the empty string from a real value", () => {
        expect.assertions(4);

        // The whole point of the chip: `column = ''` and `column IS NULL` are
        // different filters, and both would otherwise render as blank.
        expect(chipValue(null)).toBe("∅");
        expect(chipValue(undefined)).toBe("∅");
        expect(chipValue("")).toBe("(empty)");
        expect(chipValue("ada")).toBe("ada");
    });

    it("renders non-string primitives and objects readably", () => {
        expect.assertions(4);

        expect(chipValue(0)).toBe("0");
        expect(chipValue(false)).toBe("false");
        expect(chipValue({ a: 1 })).toBe('{"a":1}');
        expect(chipValue([1, 2])).toBe("[1,2]");
    });
});
