import { describe, expect, it } from "vitest";

import { defineWorkflow, isWorkflowDefinition, workflowBindingName, workflowClassName, workflowDefaultName } from "../src/define-workflow";

describe("defineWorkflow", () => {
    it("brands a valid definition", () => {
        const definition = defineWorkflow({ handler: async () => "ok" });

        expect(definition.isLunoraWorkflow).toBe(true);
        expect(isWorkflowDefinition(definition)).toBe(true);
        expect(typeof definition.handler).toBe("function");
    });

    it("preserves an explicit name override", () => {
        const definition = defineWorkflow({ handler: async () => undefined, name: "custom" });

        expect(definition.name).toBe("custom");
    });

    it("throws when handler is not a function", () => {
        // @ts-expect-error -- exercising the runtime guard for JS callers
        expect(() => defineWorkflow({ handler: "nope" })).toThrow(/`handler` must be a function/);
    });

    it("throws when name is an empty string", () => {
        expect(() => defineWorkflow({ handler: async () => undefined, name: "" })).toThrow(/`name` must be a non-empty string/);
    });
});

describe("isWorkflowDefinition", () => {
    it("rejects non-definitions", () => {
        expect(isWorkflowDefinition(null)).toBe(false);
        expect(isWorkflowDefinition({})).toBe(false);
        expect(isWorkflowDefinition({ isLunoraWorkflow: false })).toBe(false);
        expect(isWorkflowDefinition("string")).toBe(false);
    });
});

describe("naming helpers", () => {
    it("derives the class name", () => {
        expect(workflowClassName("orderPipeline")).toBe("OrderPipelineWorkflow");
        expect(workflowClassName("etl")).toBe("EtlWorkflow");
    });

    it("derives the SCREAMING_SNAKE binding name", () => {
        expect(workflowBindingName("orderPipeline")).toBe("WORKFLOW_ORDER_PIPELINE");
        expect(workflowBindingName("etl")).toBe("WORKFLOW_ETL");
        expect(workflowBindingName("syncWithStripe")).toBe("WORKFLOW_SYNC_WITH_STRIPE");
    });

    it("derives the kebab default name", () => {
        expect(workflowDefaultName("orderPipeline")).toBe("order-pipeline");
        expect(workflowDefaultName("etl")).toBe("etl");
    });
});
