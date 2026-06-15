import { describe, expect, it } from "vitest";

import { deserializePreloaded, serializePreloaded } from "../../src/ssr/serialize-preloaded";
import type { Preloaded } from "../../src/types";

const makePreloaded = (): Preloaded<{ items: string[] }> => {
    return {
        __lunoraPreloaded: true,
        args: { roomId: "room_1", limit: 20 },
        functionPath: "messages:list",
        shardKey: "room_1",
        value: { items: ["a", "b", "c"] },
    };
};

describe("serializePreloaded", () => {
    it("round-trips a Preloaded token through JSON.parse(JSON.stringify(...))", () => {
        const preloaded = makePreloaded();

        // Asserting the explicit JSON round-trip is the point of this test —
        // structuredClone would defeat it by not exercising serialization.
        // eslint-disable-next-line unicorn/prefer-structured-clone -- intentional JSON round-trip assertion.
        const roundTripped = JSON.parse(JSON.stringify(preloaded));

        expect(roundTripped).toEqual(preloaded);
    });

    it("round-trips through serializePreloaded -> deserializePreloaded", () => {
        const preloaded = makePreloaded();

        const restored = deserializePreloaded<{ items: string[] }>(serializePreloaded(preloaded));

        expect(restored).toEqual(preloaded);
    });

    it("escapes `<` so the payload is safe to inline in a <script> tag", () => {
        const preloaded: Preloaded<string> = {
            __lunoraPreloaded: true,
            args: {},
            functionPath: "f:g",
            value: "</script><script>alert(1)</script>",
        };

        const serialized = serializePreloaded(preloaded);

        expect(serialized).not.toContain("</script>");
        // The escape is transparent to JSON.parse — value survives intact.
        expect(deserializePreloaded<string>(serialized).value).toBe("</script><script>alert(1)</script>");
    });
});
