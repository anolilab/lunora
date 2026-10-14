/**
 * Real-D1 value encoding for `@lunora/d1`.
 *
 * Every assertion here is about what an engine does to a bound value, and the
 * node:sqlite harness cannot settle that on its own: it is a different SQLite
 * build from the one workerd ships, and the whole defect class is a column whose
 * declared AFFINITY silently rewrites what is stored in it. The `"1.0"` this
 * pins is exactly such a rewrite — a number bound to a TEXT column — so the
 * column types D1 actually provisioned are asserted alongside the values, and
 * both come from the real binding rather than from a stand-in.
 */
import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

interface ValueEncodingResult {
    columnTypes: Record<string, string>;
    document: {
        litBigint: unknown;
        litBoolean: unknown;
        litNumber: unknown;
        litString: unknown;
        optAny: unknown;
        optAnyPresent: boolean;
        optStringPresent: boolean;
        untyped: unknown;
    };
}

const roundTrip = async (): Promise<ValueEncodingResult> => {
    const response = await SELF.fetch("https://example.com/value-encoding", { method: "POST" });

    if (response.status !== 200) {
        throw new Error(`/value-encoding returned ${String(response.status)}: ${await response.text()}`);
    }

    return await response.json();
};

describe("value encoding against a real D1 database", () => {
    it("provisions each v.literal() column with its payload's affinity", async () => {
        expect.assertions(4);

        const { columnTypes } = await roundTrip();

        expect(columnTypes["litNumber"]).toBe("REAL");
        expect(columnTypes["litBoolean"]).toBe("INTEGER");
        expect(columnTypes["litBigint"]).toBe("TEXT");
        expect(columnTypes["litString"]).toBe("TEXT");
    });

    it("round-trips a v.literal() column's payload as its own JS type", async () => {
        expect.assertions(4);

        // Each of these came back as the text `"1.0"` — D1's TEXT affinity
        // rewriting the bound value — or, for the bigint, as 40 characters of
        // sort-key padding. A row written that way then failed its own validator
        // on the next patch.
        const { document } = await roundTrip();

        expect(document.litNumber).toBe(1);
        expect(document.litBoolean).toBe(true);
        expect(document.litBigint).toBe("7n");
        expect(document.litString).toBe("x");
    });

    it("keeps a null explicitly written to v.optional(v.any()) and still reads an unset optional as absent", async () => {
        expect.assertions(3);

        const { document } = await roundTrip();

        expect(document.optAnyPresent).toBe(true);
        expect(document.optAny).toBeNull();
        expect(document.optStringPresent).toBe(false);
    });

    it("returns a user string that merely looks like a wire payload as itself", async () => {
        expect.assertions(1);

        // Not `42`. The stored text is indistinguishable from an encoded payload
        // without the escape, so this column handed back a number.
        const { document } = await roundTrip();

        expect(document.untyped).toBe("$lunora.wire$42");
    });
});
