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
        expect.assertions(1);

        const preloaded = makePreloaded();

        // Asserting the explicit JSON round-trip is the point of this test —
        // structuredClone would defeat it by not exercising serialization.
        // eslint-disable-next-line unicorn/prefer-structured-clone -- intentional JSON round-trip assertion.
        const roundTripped = JSON.parse(JSON.stringify(preloaded));

        expect(roundTripped).toEqual(preloaded);
    });

    it("round-trips through serializePreloaded -> deserializePreloaded", () => {
        expect.assertions(1);

        const preloaded = makePreloaded();

        const restored = deserializePreloaded<{ items: string[] }>(serializePreloaded(preloaded));

        expect(restored).toEqual(preloaded);
    });

    it("escapes `<` so the payload is safe to inline in a &lt;script&gt; tag", () => {
        expect.assertions(2);

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

    it("round-trips a bigint value instead of throwing", () => {
        expect.assertions(2);

        const preloaded: Preloaded<{ views: bigint }> = {
            __lunoraPreloaded: true,
            args: { since: 42n },
            functionPath: "posts:get",
            value: { views: 9_007_199_254_740_993n },
        };

        const restored = deserializePreloaded<{ views: bigint }>(serializePreloaded(preloaded));

        expect(restored.value.views).toBe(9_007_199_254_740_993n);
        expect((restored.args as { since: bigint }).since).toBe(42n);
    });

    it("round-trips an ArrayBuffer value instead of degrading it to an index-keyed object", () => {
        expect.assertions(1);

        const avatar = new Uint8Array([137, 80, 78, 71]).buffer;
        const preloaded: Preloaded<{ avatar: ArrayBuffer }> = {
            __lunoraPreloaded: true,
            args: {},
            functionPath: "users:get",
            value: { avatar },
        };

        const restored = deserializePreloaded<{ avatar: ArrayBuffer }>(serializePreloaded(preloaded));

        expect([...new Uint8Array(restored.value.avatar)]).toStrictEqual([137, 80, 78, 71]);
    });
});
