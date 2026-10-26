import { LunoraProvider } from "@lunora/react";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactElement } from "react";
import { describe, expect, it } from "vitest";

import WorkflowsPanel from "../../../src/features/workflows/workflows-panel";
import type { WorkflowsResult } from "../../../src/lib/admin";
import { ADMIN_FUNCTIONS } from "../../../src/lib/admin";
import type { MockClientHooks } from "../../mock-client";
import { createMockClient } from "../../mock-client";

const METADATA: WorkflowsResult = {
    workflows: [
        { className: "OrderPipelineWorkflow", exportName: "orderPipeline", name: "order-pipeline" },
        { className: "BillingWorkflow", exportName: "billing", name: "billing" },
    ],
};

/** A client whose `listWorkflows` admin query returns the fixed metadata above. */
const createWorkflowsClient = (result: WorkflowsResult = METADATA): MockClientHooks =>
    createMockClient({
        query: (reference): unknown => {
            if (reference === ADMIN_FUNCTIONS.listWorkflows) {
                return result;
            }

            throw new Error(`unexpected query: ${reference}`);
        },
    });

const renderPanel = (mock: MockClientHooks): ReactElement => (
    <LunoraProvider client={mock.asClient}>
        <WorkflowsPanel />
    </LunoraProvider>
);

describe("workflowsPanel", () => {
    it("lists each workflow's export, name, and class", async () => {
        expect.assertions(3);

        render(renderPanel(createWorkflowsClient()));

        const row = await screen.findByTestId("workflows-row-orderPipeline");

        expect(row.textContent).toContain("orderPipeline");
        expect(row.textContent).toContain("order-pipeline");
        expect(row.textContent).toContain("OrderPipelineWorkflow");
    });

    it("sorts workflows by export name", async () => {
        expect.assertions(1);

        render(renderPanel(createWorkflowsClient()));

        await screen.findByTestId("workflows-row-orderPipeline");

        const rows = screen.getAllByTestId(/^workflows-row-/);

        expect(rows.map((row) => row.dataset.testid)).toStrictEqual(["workflows-row-billing", "workflows-row-orderPipeline"]);
    });

    it("shows the empty state when no workflows are defined", async () => {
        expect.assertions(1);

        render(renderPanel(createWorkflowsClient({ workflows: [] })));

        const empty = await screen.findByTestId("workflows-empty");

        expect(empty).toBeDefined();
    });

    it("starts an instance and observes its status", async () => {
        expect.assertions(4);

        const calls: { args: Record<string, unknown>; reference: string }[] = [];
        const mock = createMockClient({
            query: (reference, args): unknown => {
                calls.push({ args: args as Record<string, unknown>, reference });

                if (reference === ADMIN_FUNCTIONS.listWorkflows) {
                    return METADATA;
                }

                if (reference === ADMIN_FUNCTIONS.createWorkflowInstance) {
                    return { id: "wf-1", status: "queued" };
                }

                if (reference === ADMIN_FUNCTIONS.getWorkflowInstanceStatus) {
                    return { id: "wf-1", output: { ok: true }, status: "complete" };
                }

                throw new Error(`unexpected query: ${reference}`);
            },
        });

        render(renderPanel(mock));

        await screen.findByTestId("workflows-row-billing");

        fireEvent.change(screen.getByTestId("workflows-start-select"), { target: { value: "orderPipeline" } });
        fireEvent.change(screen.getByTestId("workflows-start-params"), { target: { value: '{"orderId":"o1"}' } });
        fireEvent.click(screen.getByTestId("workflows-start-button"));

        const row = await screen.findByTestId("workflows-instance-wf-1");

        expect(row.textContent).toContain("queued");

        // The create call carried the selected export and the parsed JSON params.
        const create = calls.find((call) => call.reference === ADMIN_FUNCTIONS.createWorkflowInstance);

        expect(create?.args).toMatchObject({ exportName: "orderPipeline", params: { orderId: "o1" } });

        fireEvent.click(screen.getByTestId("workflows-instance-refresh-wf-1"));

        // Plain-throw wait (no `expect`) so retries don't inflate the assertion count.
        await waitFor(() => {
            if (!screen.getByTestId("workflows-instance-wf-1").textContent?.includes("complete")) {
                throw new Error("status not refreshed yet");
            }
        });

        expect(screen.getByTestId("workflows-instance-wf-1").textContent).toContain("complete");
        expect(screen.getByTestId("workflows-instance-wf-1").textContent).toContain('{"ok":true}');
    });

    it("rejects invalid JSON params before starting", async () => {
        expect.hasAssertions();

        const mock = createMockClient({
            query: (reference): unknown => {
                if (reference === ADMIN_FUNCTIONS.listWorkflows) {
                    return METADATA;
                }

                throw new Error(`unexpected query: ${reference}`);
            },
        });

        render(renderPanel(mock));

        await screen.findByTestId("workflows-row-billing");

        fireEvent.change(screen.getByTestId("workflows-start-params"), { target: { value: "{not json" } });
        fireEvent.click(screen.getByTestId("workflows-start-button"));

        await waitFor(() => {
            expect(screen.getByTestId("workflows-start-error").textContent).toContain("valid JSON");
        });

        // No instance row was created — the bad-params guard short-circuited the call.
        expect(screen.queryByTestId("workflows-instances")).toBeNull();
    });

    it("sends an event to an instance and refreshes its row", async () => {
        expect.assertions(2);

        const calls: { args: Record<string, unknown>; reference: string }[] = [];
        const mock = createMockClient({
            query: (reference, args): unknown => {
                calls.push({ args: args as Record<string, unknown>, reference });

                if (reference === ADMIN_FUNCTIONS.listWorkflows) {
                    return METADATA;
                }

                if (reference === ADMIN_FUNCTIONS.sendWorkflowEvent) {
                    return { sent: true };
                }

                if (reference === ADMIN_FUNCTIONS.getWorkflowInstanceStatus) {
                    return { id: "wf-1", status: "running" };
                }

                throw new Error(`unexpected query: ${reference}`);
            },
        });

        render(renderPanel(mock));

        await screen.findByTestId("workflows-row-billing");

        fireEvent.change(screen.getByTestId("workflows-start-select"), { target: { value: "orderPipeline" } });
        fireEvent.change(screen.getByTestId("workflows-event-id"), { target: { value: "wf-1" } });
        fireEvent.change(screen.getByTestId("workflows-event-type"), { target: { value: "order-approved" } });
        fireEvent.change(screen.getByTestId("workflows-event-payload"), { target: { value: '{"approvedBy":"ops"}' } });
        fireEvent.click(screen.getByTestId("workflows-event-button"));

        const row = await screen.findByTestId("workflows-instance-wf-1");

        expect(row.textContent).toContain("running");
        expect(calls.find((call) => call.reference === ADMIN_FUNCTIONS.sendWorkflowEvent)?.args).toStrictEqual({
            exportName: "orderPipeline",
            id: "wf-1",
            payload: { approvedBy: "ops" },
            type: "order-approved",
        });
    });

    it("shows a failed refresh after a send in the event form, not the start form", async () => {
        expect.hasAssertions();

        const mock = createMockClient({
            query: (reference): unknown => {
                if (reference === ADMIN_FUNCTIONS.listWorkflows) {
                    return METADATA;
                }

                if (reference === ADMIN_FUNCTIONS.sendWorkflowEvent) {
                    return { sent: true };
                }

                throw new Error("status unavailable");
            },
        });

        render(renderPanel(mock));

        await screen.findByTestId("workflows-row-billing");

        fireEvent.change(screen.getByTestId("workflows-event-id"), { target: { value: "wf-1" } });
        fireEvent.change(screen.getByTestId("workflows-event-type"), { target: { value: "order-approved" } });
        fireEvent.click(screen.getByTestId("workflows-event-button"));

        await waitFor(() => {
            expect(screen.getByTestId("workflows-event-error").textContent).toContain("status unavailable");
        });

        expect(screen.queryByTestId("workflows-start-error")).toBeNull();
    });

    it("offers the declared event types on the event type input", async () => {
        expect.assertions(2);

        render(renderPanel(createWorkflowsClient({ ...METADATA, eventTypes: [" padded ", "order-approved"] })));

        const input = await screen.findByTestId("workflows-event-type");
        const options = within(screen.getByTestId("workflows-event-types"))
            .getAllByRole("option", { hidden: true })
            .map((option) => (option as HTMLOptionElement).value);

        expect(input.getAttribute("list")).toBe("workflows-event-types");
        expect(options).toStrictEqual([" padded ", "order-approved"]);
    });

    it("rejects an invalid JSON event payload before sending", async () => {
        expect.hasAssertions();

        const references: string[] = [];
        const mock = createMockClient({
            query: (reference): unknown => {
                references.push(reference);

                if (reference === ADMIN_FUNCTIONS.listWorkflows) {
                    return METADATA;
                }

                throw new Error(`unexpected query: ${reference}`);
            },
        });

        render(renderPanel(mock));

        await screen.findByTestId("workflows-row-billing");

        fireEvent.change(screen.getByTestId("workflows-event-id"), { target: { value: "wf-1" } });
        fireEvent.change(screen.getByTestId("workflows-event-type"), { target: { value: "order-approved" } });
        fireEvent.change(screen.getByTestId("workflows-event-payload"), { target: { value: "{not json" } });
        fireEvent.click(screen.getByTestId("workflows-event-button"));

        await waitFor(() => {
            expect(screen.getByTestId("workflows-event-error").textContent).toContain("valid JSON");
        });

        expect(references).not.toContain(ADMIN_FUNCTIONS.sendWorkflowEvent);
    });

    it("surfaces an admin error", async () => {
        expect.hasAssertions();

        const mock = createMockClient({
            query: (): unknown => {
                throw new Error("not authorized");
            },
        });

        render(renderPanel(mock));

        await waitFor(() => {
            expect(screen.getByTestId("workflows-error").textContent).toContain("not authorized");
        });
    });
});
