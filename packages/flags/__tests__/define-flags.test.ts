import { describe, expect, it } from "vitest";

import { defineFlags, isFlagsDefinition } from "../src/define-flags";

const provider = () => ({}) as never;

describe("defineFlags", () => {
    it("brands a valid config", () => {
        const def = defineFlags({ provider });

        expect(def.isLunoraFlags).toBe(true);
        expect(def.provider).toBe(provider);
        expect(isFlagsDefinition(def)).toBe(true);
    });

    it("preserves identify and hooks", () => {
        const identify = (auth: { userId: string | null }) => auth.userId ?? undefined;
        const hooks: never[] = [];
        const def = defineFlags({ hooks, identify, provider });

        expect(def.identify).toBe(identify);
        expect(def.hooks).toBe(hooks);
    });

    it("throws when provider is not a function", () => {
        // @ts-expect-error — exercising the runtime guard
        expect(() => defineFlags({ provider: "FLAGS" })).toThrow(/provider/);
    });

    it("throws when identify is not a function", () => {
        // @ts-expect-error — exercising the runtime guard
        expect(() => defineFlags({ identify: "user", provider })).toThrow(/identify/);
    });

    it("throws when hooks is not an array", () => {
        // @ts-expect-error — exercising the runtime guard
        expect(() => defineFlags({ hooks: {}, provider })).toThrow(/hooks/);
    });
});

describe("isFlagsDefinition", () => {
    it("rejects non-branded values", () => {
        expect(isFlagsDefinition(null)).toBe(false);
        expect(isFlagsDefinition({})).toBe(false);
        expect(isFlagsDefinition({ provider })).toBe(false);
        expect(isFlagsDefinition("flags")).toBe(false);
    });
});
