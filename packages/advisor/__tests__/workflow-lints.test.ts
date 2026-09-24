import { defineSchema, defineTable } from "@lunora/server";
import { v } from "@lunora/values";
import { describe, expect, it } from "vitest";

import type { AdvisorWorkflow, AdvisorWorkflowCall, LintContext } from "../src";
import { fromServerSchema } from "../src";
import workflowDuplicateStepName from "../src/lints/static/workflow-duplicate-step-name";
import workflowUnknownTarget from "../src/lints/static/workflow-unknown-target";
import workflowUnused from "../src/lints/static/workflow-unused";

const schema = () => fromServerSchema(defineSchema({ channels: defineTable({ name: v.string() }) }));

const context = (parts: Partial<LintContext>): LintContext => {
    return { schema: schema(), ...parts };
};

const WELCOME: AdvisorWorkflow = { exportName: "channelWelcome" };
const CLEANUP: AdvisorWorkflow = { exportName: "nightlyCleanup" };

describe("workflow_unused", () => {
    it("finds nothing without both the declared set and the call sites", () => {
        expect.assertions(2);

        // A runtime caller (no workflow feeder) must not flag anything, and
        // neither must a caller that supplies declarations without call sites:
        // with no usage evidence the "started" set is empty, so every declared
        // workflow would otherwise be reported as never started.
        expect(workflowUnused.run(context({}))).toHaveLength(0);
        expect(workflowUnused.run(context({ workflows: [WELCOME, CLEANUP] }))).toHaveLength(0);
    });

    it("flags a declared workflow nothing starts", () => {
        expect.assertions(2);

        const findings = workflowUnused.run(context({ workflowCalls: [], workflows: [WELCOME] }));

        expect(findings).toHaveLength(1);
        expect(findings[0]).toMatchObject({
            cacheKey: "workflow_unused:channelWelcome",
            level: "INFO",
            metadata: { workflow: "channelWelcome" },
            name: "workflow_unused",
        });
    });

    it("clears a workflow that is started somewhere", () => {
        expect.assertions(1);

        const calls: AdvisorWorkflowCall[] = [{ exportName: "create", file: "channels", line: 4, workflow: "channelWelcome" }];

        expect(workflowUnused.run(context({ workflowCalls: calls, workflows: [WELCOME] }))).toHaveLength(0);
    });

    it("flags only the workflows with no call site", () => {
        expect.assertions(1);

        const calls: AdvisorWorkflowCall[] = [{ exportName: "create", file: "channels", line: 4, workflow: "channelWelcome" }];
        const findings = workflowUnused.run(context({ workflowCalls: calls, workflows: [WELCOME, CLEANUP] }));

        expect(findings.map((finding) => finding.metadata.workflow)).toStrictEqual(["nightlyCleanup"]);
    });

    it("stays silent when any call uses a dynamic (non-literal) name", () => {
        expect.assertions(1);

        // A dynamic get(<expr>) could target any workflow — flagging unused would be a false positive.
        const calls: AdvisorWorkflowCall[] = [{ exportName: "dynamic", file: "channels", line: 9, workflow: "" }];

        expect(workflowUnused.run(context({ workflowCalls: calls, workflows: [WELCOME, CLEANUP] }))).toHaveLength(0);
    });
});

describe("workflow_unknown_target", () => {
    it("finds nothing without both the declared set and the call sites", () => {
        expect.assertions(2);

        expect(workflowUnknownTarget.run(context({ workflows: [WELCOME] }))).toHaveLength(0);
        expect(workflowUnknownTarget.run(context({ workflowCalls: [] }))).toHaveLength(0);
    });

    it("flags a call referencing an undeclared workflow", () => {
        expect.assertions(2);

        const calls: AdvisorWorkflowCall[] = [{ exportName: "create", file: "channels", line: 4, workflow: "channelWelcom" }];
        const findings = workflowUnknownTarget.run(context({ workflowCalls: calls, workflows: [WELCOME] }));

        expect(findings).toHaveLength(1);
        expect(findings[0]).toMatchObject({
            cacheKey: "workflow_unknown_target:channels:create:channelWelcom",
            level: "ERROR",
            metadata: { exportName: "create", workflow: "channelWelcom" },
            name: "workflow_unknown_target",
        });
    });

    it("clears a call referencing a declared workflow", () => {
        expect.assertions(1);

        const calls: AdvisorWorkflowCall[] = [{ exportName: "create", file: "channels", line: 4, workflow: "channelWelcome" }];

        expect(workflowUnknownTarget.run(context({ workflowCalls: calls, workflows: [WELCOME] }))).toHaveLength(0);
    });

    it("ignores calls with a dynamic (non-literal) name", () => {
        expect.assertions(1);

        const calls: AdvisorWorkflowCall[] = [{ exportName: "dynamic", file: "channels", line: 9, workflow: "" }];

        expect(workflowUnknownTarget.run(context({ workflowCalls: calls, workflows: [WELCOME] }))).toHaveLength(0);
    });
});

// eslint-disable-next-line no-secrets/no-secrets -- the lint's rule id, not a credential
describe("workflow_duplicate_step_name", () => {
    it("finds nothing when no declaration evidence is supplied", () => {
        expect.assertions(1);

        // A runtime caller (no workflow feeder) must not flag anything.
        expect(workflowDuplicateStepName.run(context({}))).toHaveLength(0);
    });

    it("clears a workflow whose step names are all unique", () => {
        expect.assertions(1);

        const workflows: AdvisorWorkflow[] = [
            {
                exportName: "orderPipeline",
                steps: [
                    { line: 3, method: "do", name: "load" },
                    { line: 4, method: "sleep", name: "cool-off" },
                    { line: 5, method: "do", name: "charge" },
                ],
            },
        ];

        expect(workflowDuplicateStepName.run(context({ workflows }))).toHaveLength(0);
    });

    it("flags a reused step name, pointing at the first and the duplicate line", () => {
        expect.assertions(2);

        const workflows: AdvisorWorkflow[] = [
            {
                exportName: "orderPipeline",
                steps: [
                    { line: 3, method: "do", name: "charge" },
                    { line: 7, method: "do", name: "charge" },
                ],
            },
        ];

        const findings = workflowDuplicateStepName.run(context({ workflows }));

        expect(findings).toHaveLength(1);
        expect(findings[0]).toMatchObject({
            // eslint-disable-next-line no-secrets/no-secrets -- the lint's cache key, not a credential
            cacheKey: "workflow_duplicate_step_name:orderPipeline:charge",
            level: "ERROR",
            metadata: { firstLine: 3, line: 7, stepName: "charge", workflow: "orderPipeline" },
            // eslint-disable-next-line no-secrets/no-secrets -- the lint's rule id, not a credential
            name: "workflow_duplicate_step_name",
        });
    });

    it("flags a name reused across different step methods (the cache key is the name)", () => {
        expect.assertions(1);

        const workflows: AdvisorWorkflow[] = [
            {
                exportName: "orderPipeline",
                steps: [
                    { line: 3, method: "do", name: "settle" },
                    { line: 6, method: "sleep", name: "settle" },
                ],
            },
        ];

        expect(workflowDuplicateStepName.run(context({ workflows }))).toHaveLength(1);
    });

    it("emits one finding per duplicated name even when a name repeats three times", () => {
        expect.assertions(1);

        const workflows: AdvisorWorkflow[] = [
            {
                exportName: "orderPipeline",
                steps: [
                    { line: 3, method: "do", name: "charge" },
                    { line: 5, method: "do", name: "charge" },
                    { line: 7, method: "do", name: "charge" },
                ],
            },
        ];

        expect(workflowDuplicateStepName.run(context({ workflows }))).toHaveLength(1);
    });
});
