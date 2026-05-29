import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";

import { ScheduledJobs, type ScheduleRecord } from "../src/scheduled-jobs.js";

const RECORDS: ScheduleRecord[] = [
    { args: {}, enqueuedAt: 1, functionPath: "email:send", id: "b", scheduledFor: 2000 },
    { args: {}, enqueuedAt: 1, functionPath: "report:build", id: "a", scheduledFor: 1000, shardKey: "tenant-1" },
];

describe("scheduledJobs", () => {
    test("renders jobs soonest-due first", async () => {
        const loadJobs = vi.fn(async () => RECORDS);

        render(<ScheduledJobs loadJobs={loadJobs} />);

        await waitFor(() => {
            expect(screen.getByTestId("sj-table")).toBeDefined();
        });

        const rows = screen.getAllByTestId(/^sj-row-/);

        expect(rows[0]?.dataset.testid).toBe("sj-row-a");
        expect(rows[1]?.dataset.testid).toBe("sj-row-b");
    });

    test("shows empty state when there are no jobs", async () => {
        render(<ScheduledJobs loadJobs={async () => []} />);

        await waitFor(() => {
            expect(screen.getByTestId("sj-empty")).toBeDefined();
        });
    });

    test("hides cancel controls when no canceller is supplied", async () => {
        render(<ScheduledJobs loadJobs={async () => RECORDS} />);

        await waitFor(() => {
            expect(screen.getByTestId("sj-table")).toBeDefined();
        });

        expect(screen.queryByTestId("sj-cancel-a")).toBeNull();
    });

    test("cancels a job and refetches", async () => {
        const loadJobs = vi.fn(async () => RECORDS);
        const cancelJob = vi.fn(async () => ({ cancelled: true }));

        render(<ScheduledJobs cancelJob={cancelJob} loadJobs={loadJobs} />);

        await waitFor(() => {
            expect(screen.getByTestId("sj-cancel-a")).toBeDefined();
        });

        fireEvent.click(screen.getByTestId("sj-cancel-a"));

        await waitFor(() => {
            expect(cancelJob).toHaveBeenCalledWith("a");
        });

        expect(loadJobs.mock.calls.length).toBeGreaterThanOrEqual(2);
    });
});
