import type { FunctionReference } from "@lunora/client";
import { describe, expect, it } from "vitest";

import { keyHash, lunoraQueryKey, serializeQueryKey } from "../src/query-key";

/**
 * `keyHash`/`serializeQueryKey` route a queryKey through the shared
 * `stableStringify` encoder (`shared/stable-key.ts`) so two structurally-equal
 * keys built with a different property order hash identically — preventing
 * duplicate WS subscriptions and spurious effect re-attaches. These tests pin
 * the now-shared semantics (order stability + `undefined`-field skipping) so they
 * can't drift from the encoder's contract (mirrors `@lunora/do`'s assertions).
 */
const fn = (ref: string): FunctionReference => {
    return { __lunoraRef: ref };
};

describe("keyHash", () => {
    it("is insensitive to arg property insertion order", () => {
        expect.assertions(1);

        const a = keyHash(lunoraQueryKey(fn("messages:list"), { channel: "general", limit: 10 }, undefined));
        const b = keyHash(lunoraQueryKey(fn("messages:list"), { limit: 10, channel: "general" }, undefined));

        expect(a).toBe(b);
    });

    it("treats an explicit `undefined` field the same as an absent one", () => {
        expect.assertions(1);

        const withUndefined = keyHash(lunoraQueryKey(fn("q"), { cursor: undefined, limit: 10 }, undefined));
        const without = keyHash(lunoraQueryKey(fn("q"), { limit: 10 }, undefined));

        expect(withUndefined).toBe(without);
    });

    it("discriminates by function ref and shard key", () => {
        expect.assertions(2);

        const base = keyHash(lunoraQueryKey(fn("q"), { limit: 10 }, undefined));

        expect(keyHash(lunoraQueryKey(fn("other"), { limit: 10 }, undefined))).not.toBe(base);
        expect(keyHash(lunoraQueryKey(fn("q"), { limit: 10 }, "shard-1"))).not.toBe(base);
    });

    it("serializeQueryKey matches keyHash", () => {
        expect.assertions(1);

        const key = lunoraQueryKey(fn("q"), { limit: 10 }, undefined);

        expect(serializeQueryKey(key)).toBe(keyHash(key));
    });
});
