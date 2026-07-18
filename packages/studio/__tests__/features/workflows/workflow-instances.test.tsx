import type { WorkflowInstanceAction, WorkflowInstanceDetail, WorkflowInstanceStatus, WorkflowInstanceSummary } from "@lunora/client";
import { LunoraProvider } from "@lunora/react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactElement, ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

import { WorkflowInstanceHistory } from "../../../src/features/workflows/workflow-instances";
import type { MockClientHooks } from "../../mock-client";
import { createMockClient } from "../../mock-client";

const withProvider = (mock: MockClientHooks, children: ReactNode): ReactElement => <LunoraProvider client={mock.asClient}>{children}</LunoraProvider>;

const INSTANCES: WorkflowInstanceSummary[] = [
    { createdOn: "2026-06-01T00:00:00Z", id: "i1", status: "running" },
    { id: "i2", status: "complete" },
];

const DETAIL: WorkflowInstanceDetail = {
    id: "i1",
    status: "running",
    steps: [
        { attempts: 2, name: "charge", start: "t1", success: true, type: "step" },
        { name: "wait", type: "sleep" },
    ],
};

describe("workflowInstanceHistory", () => {
    it("lists instances for the workflow on mount", async () => {
        expect.assertions(2);

        const loadInstances = vi.fn<(args: { name: string; status?: WorkflowInstanceStatus }) => Promise<WorkflowInstanceSummary[]>>(async () => INSTANCES);
        render(withProvider(createMockClient(), <WorkflowInstanceHistory loadInstances={loadInstances} workflowName="orders" />));

        await screen.findByTestId("workflow-instance-i1");

        expect(screen.getByTestId("workflow-instance-i2")).toBeDefined();
        expect(loadInstances).toHaveBeenCalledWith({ name: "orders", status: undefined });
    });

    it("reloads with a status filter when the dropdown changes", async () => {
        expect.hasAssertions();

        const loadInstances = vi.fn<(args: { name: string; status?: WorkflowInstanceStatus }) => Promise<WorkflowInstanceSummary[]>>(async () => INSTANCES);
        render(withProvider(createMockClient(), <WorkflowInstanceHistory loadInstances={loadInstances} workflowName="orders" />));

        await screen.findByTestId("workflow-instance-i1");
        fireEvent.change(screen.getByTestId("workflow-instances-filter"), { target: { value: "running" } });

        await waitFor(() => {
            expect(loadInstances).toHaveBeenCalledWith({ name: "orders", status: "running" });
        });
    });

    it("opens a step timeline when an instance's Steps button is clicked", async () => {
        expect.assertions(2);

        const loadDetail = vi.fn<(args: { id: string; name: string }) => Promise<WorkflowInstanceDetail>>(async () => DETAIL);
        render(
            withProvider(createMockClient(), <WorkflowInstanceHistory loadDetail={loadDetail} loadInstances={async () => INSTANCES} workflowName="orders" />),
        );

        fireEvent.click(await screen.findByTestId("workflow-instance-steps-i1"));

        await screen.findByTestId("workflow-instance-detail");

        expect(loadDetail).toHaveBeenCalledWith({ id: "i1", name: "orders" });
        expect(screen.getByTestId("workflow-step-0").textContent).toContain("charge");
    });

    it("shows the not-configured state when the proxy reports WORKFLOWS_NOT_CONFIGURED", async () => {
        expect.assertions(1);

        const loadInstances = vi.fn<(args: { name: string; status?: WorkflowInstanceStatus }) => Promise<WorkflowInstanceSummary[]>>(async () => {
            throw Object.assign(new Error("unconfigured"), { code: "WORKFLOWS_NOT_CONFIGURED" });
        });
        render(withProvider(createMockClient(), <WorkflowInstanceHistory loadInstances={loadInstances} workflowName="orders" />));

        await screen.findByTestId("workflow-instances-unconfigured");

        expect(screen.getByTestId("workflow-instances-unconfigured")).toBeDefined();
    });

    it("runs a lifecycle action and reloads when a handler is supplied", async () => {
        expect.hasAssertions();

        const loadInstances = vi.fn<(args: { name: string; status?: WorkflowInstanceStatus }) => Promise<WorkflowInstanceSummary[]>>(async () => INSTANCES);
        const runAction = vi.fn<(args: { action: WorkflowInstanceAction; id: string; name: string }) => Promise<{ status: WorkflowInstanceStatus }>>(
            async () => {
                return { status: "paused" as WorkflowInstanceStatus };
            },
        );
        render(withProvider(createMockClient(), <WorkflowInstanceHistory loadInstances={loadInstances} runAction={runAction} workflowName="orders" />));

        fireEvent.click(await screen.findByTestId("workflow-instance-pause-i1"));

        await waitFor(() => {
            expect(runAction).toHaveBeenCalledWith({ action: "pause", id: "i1", name: "orders" });
        });

        // a reload follows the action (mount load + post-action load)
        expect(loadInstances.mock.calls.length).toBeGreaterThanOrEqual(2);
    });

    it("is read-only (no action buttons) when given a custom loader without a handler", async () => {
        expect.assertions(1);

        render(withProvider(createMockClient(), <WorkflowInstanceHistory loadInstances={async () => INSTANCES} workflowName="orders" />));

        await screen.findByTestId("workflow-instance-i1");

        expect(screen.queryByTestId("workflow-instance-pause-i1")).toBeNull();
    });

    it("hides lifecycle actions when readOnly, even with a handler supplied", async () => {
        expect.assertions(1);

        const runAction = vi.fn<(args: { action: WorkflowInstanceAction; id: string; name: string }) => Promise<{ status: WorkflowInstanceStatus }>>(
            async () => {
                return { status: "paused" as WorkflowInstanceStatus };
            },
        );
        render(
            withProvider(
                createMockClient(),
                <WorkflowInstanceHistory loadInstances={async () => INSTANCES} readOnly runAction={runAction} workflowName="orders" />,
            ),
        );

        await screen.findByTestId("workflow-instance-i1");

        expect(screen.queryByTestId("workflow-instance-pause-i1")).toBeNull();
    });
});
