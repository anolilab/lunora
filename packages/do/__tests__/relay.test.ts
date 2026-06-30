import { describe, expect, it } from "vitest";

import { DEFAULT_PROMOTION_THRESHOLDS, nextPromotionState, relayCountFor } from "../src/relay";

describe("relay promotion reducer", () => {
    const thresholds = { tDown: 4000, tUp: 8000 };

    it("promotes an owned key at or above tUp, holds below", () => {
        expect.assertions(3);

        expect(nextPromotionState("owned", 7999, thresholds)).toBe("owned");
        expect(nextPromotionState("owned", 8000, thresholds)).toBe("promoted");
        expect(nextPromotionState("owned", 50_000, thresholds)).toBe("promoted");
    });

    it("collapses a promoted key only below tDown, holds at or above", () => {
        expect.assertions(3);

        expect(nextPromotionState("promoted", 4000, thresholds)).toBe("promoted");
        expect(nextPromotionState("promoted", 3999, thresholds)).toBe("owned");
        expect(nextPromotionState("promoted", 0, thresholds)).toBe("owned");
    });

    it("holds the current state across the hysteresis band (no flap)", () => {
        expect.assertions(2);

        // A count of 6000 sits between tDown and tUp: whichever state we're in stays.
        expect(nextPromotionState("owned", 6000, thresholds)).toBe("owned");
        expect(nextPromotionState("promoted", 6000, thresholds)).toBe("promoted");
    });

    it("defaults to the 8000/4000 thresholds", () => {
        expect.assertions(3);

        expect(DEFAULT_PROMOTION_THRESHOLDS).toStrictEqual({ tDown: 4000, tUp: 8000 });
        expect(nextPromotionState("owned", 8000)).toBe("promoted");
        expect(nextPromotionState("promoted", 3999)).toBe("owned");
    });

    it("rejects an empty or inverted hysteresis band", () => {
        expect.assertions(2);

        expect(() => nextPromotionState("owned", 1, { tDown: 8000, tUp: 8000 })).toThrow(/tDown/);
        expect(() => nextPromotionState("owned", 1, { tDown: 9000, tUp: 8000 })).toThrow(/must be < tUp/);
    });
});

describe("relayCountFor", () => {
    it("needs no relays at or below one DO's capacity", () => {
        expect.assertions(2);

        expect(relayCountFor(8000, 8000, 8)).toBe(0);
        expect(relayCountFor(1, 8000, 8)).toBe(0);
    });

    it("sizes the relay set to the overflow above one DO's capacity", () => {
        expect.assertions(3);

        expect(relayCountFor(16_000, 8000, 8)).toBe(1); // 8k overflow → 1 relay
        expect(relayCountFor(24_001, 8000, 8)).toBe(3); // 16,001 overflow → ceil(16001/8000)=3
        expect(relayCountFor(40_000, 8000, 8)).toBe(4); // 32k overflow → 4 relays
    });

    it("never exceeds the max-relays cost ceiling", () => {
        expect.assertions(1);

        // A viral key: overflow would want many relays, but the cap holds.
        expect(relayCountFor(10_000_000, 8000, 8)).toBe(8);
    });

    it("returns zero for a non-positive capacity rather than dividing by zero", () => {
        expect.assertions(1);

        expect(relayCountFor(10_000, 0, 8)).toBe(0);
    });
});
