import { describe, expect, it } from "vitest";

import { defineFlags, isFlagsDefinition } from "../src/define-flags";

const provider = () => ({}) as never;

describe("defineFlags", () => {
    it("brands a valid config", () => {
        expect.assertions(3);

        const def = defineFlags({ provider });

        expect(def.isLunoraFlags).toBe(true);
        expect(def.provider).toBe(provider);
        expect(isFlagsDefinition(def)).toBe(true);
    });

    it("preserves identify and hooks", () => {
        expect.assertions(2);

        const identify = (auth: { userId: string | null }) => auth.userId ?? undefined;
        const hooks: never[] = [];
        const def = defineFlags({ hooks, identify, provider });

        expect(def.identify).toBe(identify);
        expect(def.hooks).toBe(hooks);
    });

    it("throws when provider is not a function", () => {
        expect.assertions(1);

        // @ts-expect-error — exercising the runtime guard
        expect(() => defineFlags({ provider: "FLAGS" })).toThrow(/provider/);
    });

    it("throws when identify is not a function", () => {
        expect.assertions(1);

        // @ts-expect-error — exercising the runtime guard
        expect(() => defineFlags({ identify: "user", provider })).toThrow(/identify/);
    });

    it("throws when hooks is not an array", () => {
        expect.assertions(1);

        // @ts-expect-error — exercising the runtime guard
        expect(() => defineFlags({ hooks: {}, provider })).toThrow(/hooks/);
    });
});

describe("isFlagsDefinition", () => {
    it("rejects non-branded values", () => {
        expect.assertions(4);

        expect(isFlagsDefinition(null)).toBe(false);
        expect(isFlagsDefinition({})).toBe(false);
        expect(isFlagsDefinition({ provider })).toBe(false);
        expect(isFlagsDefinition("flags")).toBe(false);
    });
});
