import { describe, expect, it } from "vitest";

import { midpoint } from "../lunora/ordering";

describe("midpoint", () => {
    it("orders an empty board", () => {
        expect(midpoint(null, null)).toBe("n");
    });

    it("returns a key strictly between its neighbours", () => {
        const first = midpoint(null, null);
        const after = midpoint(first, null);
        const between = midpoint(first, after);

        expect(first < between).toBe(true);
        expect(between < after).toBe(true);
    });

    it("survives repeated insertion into the same gap", () => {
        let low = midpoint(null, null);
        const high = midpoint(low, null);

        // Dropping a card into the same slot 200 times in a row is what breaks
        // float-based ordering; the key just grows a character or two.
        for (let index = 0; index < 200; index += 1) {
            const next = midpoint(low, high);

            expect(low < next).toBe(true);
            expect(next < high).toBe(true);

            low = next;
        }
    });

    it("keeps a whole column sorted as it is rebuilt front-to-back", () => {
        const keys: string[] = [];

        for (let index = 0; index < 50; index += 1) {
            keys.unshift(midpoint(null, keys[0] ?? null));
        }

        expect([...keys].sort((left, right) => (left < right ? -1 : 1))).toStrictEqual(keys);
    });

    it("rejects neighbours the caller read out of order", () => {
        expect(() => midpoint("z", "b")).toThrow(/out of order/u);
    });
});
