import { describe, expect, it } from "vitest";

import { defineWorkflow, isWorkflowDefinition, workflowClassName, workflowDefaultName } from "../src/define-workflow";

describe("defineWorkflow", () => {
    it("brands a valid definition", () => {
        expect.assertions(3);

        const definition = defineWorkflow({ handler: async () => "ok" });

        expect(definition.isLunoraWorkflow).toBe(true);
        expect(isWorkflowDefinition(definition)).toBe(true);
        expect(typeof definition.handler).toBe("function");
    });

    it("preserves an explicit name override", () => {
        expect.assertions(1);

        const definition = defineWorkflow({ handler: async () => undefined, name: "custom" });

        expect(definition.name).toBe("custom");
    });

    it("throws when handler is not a function", () => {
        expect.assertions(1);

        // @ts-expect-error -- exercising the runtime guard for JS callers
        expect(() => defineWorkflow({ handler: "nope" })).toThrow(/`handler` must be a function/);
    });

    it("throws when name is an empty string", () => {
        expect.assertions(1);

        expect(() => defineWorkflow({ handler: async () => undefined, name: "" })).toThrow(/`name` must be a non-empty string/);
    });
});

describe("defineWorkflow deploy settings", () => {
    it("carries schedules, limits and defaultRetention through", () => {
        expect.assertions(1);

        const definition = defineWorkflow({
            defaultRetention: { errorRetention: "30 days", successRetention: "3 days" },
            handler: async () => undefined,
            limits: { steps: 25_000 },
            schedules: ["0 * * * *", "*/15 * * * *"],
        });

        expect([definition.schedules, definition.limits, definition.defaultRetention]).toStrictEqual([
            ["0 * * * *", "*/15 * * * *"],
            { steps: 25_000 },
            { errorRetention: "30 days", successRetention: "3 days" },
        ]);
    });

    it.each([
        [{ schedules: [] }, /`schedules` must be a non-empty array/],
        [{ schedules: ["0 * * * *", ""] }, /`schedules` must be a non-empty array/],
        [{ limits: { steps: 0 } }, /`limits` must be an object whose `steps` is a positive integer/],
        [{ limits: { steps: 1.5 } }, /`limits` must be an object whose `steps` is a positive integer/],
        [{ defaultRetention: { successRetention: "" } }, /`defaultRetention` must be an object of duration strings/],
    ])("rejects a malformed setting %j", (settings, message) => {
        expect.assertions(1);

        expect(() => defineWorkflow({ handler: async () => undefined, ...settings })).toThrow(message);
    });
});

describe("isWorkflowDefinition", () => {
    it("rejects non-definitions", () => {
        expect.assertions(4);

        expect(isWorkflowDefinition(null)).toBe(false);
        expect(isWorkflowDefinition({})).toBe(false);
        expect(isWorkflowDefinition({ isLunoraWorkflow: false })).toBe(false);
        expect(isWorkflowDefinition("string")).toBe(false);
    });
});

describe("naming helpers", () => {
    it("derives the class name", () => {
        expect.assertions(2);

        expect(workflowClassName("orderPipeline")).toBe("OrderPipelineWorkflow");
        expect(workflowClassName("etl")).toBe("EtlWorkflow");
    });

    it("derives the kebab default name", () => {
        expect.assertions(2);

        expect(workflowDefaultName("orderPipeline")).toBe("order-pipeline");
        expect(workflowDefaultName("etl")).toBe("etl");
    });
});
