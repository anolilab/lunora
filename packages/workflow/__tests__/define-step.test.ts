import { v } from "@lunora/values";
import { describe, expect, it } from "vitest";

import { defineStep, isStepDefinition } from "../src/define-step";

describe("defineStep", () => {
    it("brands a step definition and carries its config through", () => {
        expect.assertions(6);

        const handler = async (): Promise<{ ok: boolean }> => {
            return { ok: true };
        };
        const rollback = async (): Promise<void> => {};
        const step = defineStep("charge", {
            args: { orderId: v.string() },
            config: { retries: { limit: 3 } },
            handler,
            returns: v.object({ ok: v.boolean() }),
            rollback,
            rollbackConfig: { timeout: "30 seconds" },
        });

        expect(step.isLunoraStep).toBe(true);
        expect(step.name).toBe("charge");
        expect(step.handler).toBe(handler);
        expect(step.rollback).toBe(rollback);
        expect(step.config).toEqual({ retries: { limit: 3 } });
        expect(step.rollbackConfig).toEqual({ timeout: "30 seconds" });
    });

    it("rejects a missing/empty name", () => {
        expect.assertions(1);

        expect(() => defineStep("", { args: {}, handler: async () => undefined })).toThrow(/non-empty string/);
    });

    it("rejects a non-object args", () => {
        expect.assertions(1);

        // @ts-expect-error — args must be a validator map
        expect(() => defineStep("x", { args: null, handler: async () => undefined })).toThrow(/validator map/);
    });

    it("rejects a non-function handler", () => {
        expect.assertions(1);

        // @ts-expect-error — handler must be a function
        expect(() => defineStep("x", { args: {}, handler: 42 })).toThrow(/must be a function/);
    });

    it("rejects a non-function rollback", () => {
        expect.assertions(1);

        // @ts-expect-error — rollback must be a function
        expect(() => defineStep("x", { args: {}, handler: async () => undefined, rollback: "nope" })).toThrow(/rollback/);
    });
});

describe("isStepDefinition", () => {
    it("matches defineStep results and rejects everything else", () => {
        expect.assertions(4);

        expect(isStepDefinition(defineStep("x", { args: {}, handler: async () => undefined }))).toBe(true);
        expect(isStepDefinition({})).toBe(false);
        expect(isStepDefinition(null)).toBe(false);
        expect(isStepDefinition(() => undefined)).toBe(false);
    });
});
