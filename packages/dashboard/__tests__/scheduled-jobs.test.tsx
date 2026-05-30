import { CirrusProvider } from "@cirrus/react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactElement, ReactNode } from "react";
import { describe, expect, test, vi } from "vitest";

import { ScheduledJobs, type ScheduleRecord } from "../src/scheduled-jobs.js";
import { createMockClient, type MockClientHooks } from "./mock-client.js";

const RECORDS: ScheduleRecord[] = [
    { args: {}, enqueuedAt: 1, functionPath: "email:send", id: "b", scheduledFor: 2000 },
    { args: {}, enqueuedAt: 1, functionPath: "report:build", id: "a", scheduledFor: 1000, shardKey: "tenant-1" },
];

const withProvider = (mock: MockClientHooks, children: ReactNode): ReactElement => <CirrusProvider client={mock.asClient}>{children}</CirrusProvider>;

describe("scheduledJobs", () => {
    test("renders jobs soonest-due first", async () => {
        const loadJobs = vi.fn(async () => RECORDS);

        render(withProvider(createMockClient(), <ScheduledJobs loadJobs={loadJobs} />));

        await waitFor(() => {
            expect(screen.getByTestId("sj-table")).toBeDefined();
        });

        const rows = screen.getAllByTestId(/^sj-row-/);

        expect(rows[0]?.dataset.testid).toBe("sj-row-a");
        expect(rows[1]?.dataset.testid).toBe("sj-row-b");
    });

    test("shows empty state when there are no jobs", async () => {
        render(withProvider(createMockClient(), <ScheduledJobs loadJobs={async () => []} />));

        await waitFor(() => {
            expect(screen.getByTestId("sj-empty")).toBeDefined();
        });
    });

    test("hides cancel controls for a custom read-only loader", async () => {
        render(withProvider(createMockClient(), <ScheduledJobs loadJobs={async () => RECORDS} />));

        await waitFor(() => {
            expect(screen.getByTestId("sj-table")).toBeDefined();
        });

        expect(screen.queryByTestId("sj-cancel-a")).toBeNull();
    });

    test("cancels a job and refetches", async () => {
        const loadJobs = vi.fn(async () => RECORDS);
        const cancelJob = vi.fn(async () => ({ cancelled: true }));

        render(withProvider(createMockClient(), <ScheduledJobs cancelJob={cancelJob} loadJobs={loadJobs} />));

        await waitFor(() => {
            expect(screen.getByTestId("sj-cancel-a")).toBeDefined();
        });

        fireEvent.click(screen.getByTestId("sj-cancel-a"));

        await waitFor(() => {
            expect(cancelJob).toHaveBeenCalledWith("a");
        });

        expect(loadJobs.mock.calls.length).toBeGreaterThanOrEqual(2);
    });

    test("falls back to the client's scheduler admin methods", async () => {
        const mock = createMockClient({ listScheduledJobs: () => RECORDS });

        render(withProvider(mock, <ScheduledJobs />));

        await waitFor(() => {
            expect(screen.getByTestId("sj-cancel-a")).toBeDefined();
        });

        expect(mock.listScheduledJobs).toHaveBeenCalledWith();

        fireEvent.click(screen.getByTestId("sj-cancel-a"));

        await waitFor(() => {
            expect(mock.cancelScheduledJob).toHaveBeenCalledWith("a");
        });
    });
});
