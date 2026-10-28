import type { ScheduledJobView } from "@lunora/client";
import { LunoraProvider } from "@lunora/react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { JobHistory } from "../../../src/features/logs/job-history";
import { createMockClient } from "../../mock-client";

const JOBS: ScheduledJobView[] = [
    { args: {}, completedAt: 3000, enqueuedAt: 1, functionPath: "email:send", id: "ran", scheduledFor: 2000, state: "succeeded" },
    { args: {}, completedAt: 2500, enqueuedAt: 1, functionPath: "report:build", id: "gone", scheduledFor: 2000, state: "canceled" },
    {
        args: {},
        completedAt: 2400,
        enqueuedAt: 1,
        error: "dead-lettered after 6 attempts",
        functionPath: "sync:pull",
        id: "dead",
        scheduledFor: 2000,
        state: "failed",
    },
];

describe("jobHistory", () => {
    it("shows how each finished job ended, with a failure's reason", async () => {
        expect.assertions(4);

        render(
            <LunoraProvider client={createMockClient().asClient}>
                <JobHistory
                    loadJobs={async () => {
                        return { records: JOBS };
                    }}
                />
            </LunoraProvider>,
        );

        await screen.findByTestId("job-history-table");

        expect(screen.getByTestId("job-history-state-ran").textContent).toBe("succeeded");
        expect(screen.getByTestId("job-history-state-gone").textContent).toBe("canceled");
        expect(screen.getByTestId("job-history-state-dead").textContent).toBe("failed");
        expect(screen.getByTestId("job-history-row-dead").textContent).toContain("dead-lettered after 6 attempts");
    });

    it("shows the empty state when nothing has finished", async () => {
        expect.assertions(1);

        render(
            <LunoraProvider client={createMockClient().asClient}>
                <JobHistory
                    loadJobs={async () => {
                        return { records: [] };
                    }}
                />
            </LunoraProvider>,
        );

        await expect(screen.findByTestId("job-history-empty")).resolves.toBeDefined();
    });

    it("loads older pages on demand by the returned cursor", async () => {
        expect.assertions(3);

        const [newest, ...rest] = JOBS;
        const loadJobs = vi.fn<(cursor?: string) => Promise<{ cursor?: string; records: ScheduledJobView[] }>>(async (cursor) =>
            cursor === undefined ? { cursor: "page-2", records: newest === undefined ? [] : [newest] } : { records: rest },
        );

        render(
            <LunoraProvider client={createMockClient().asClient}>
                <JobHistory loadJobs={loadJobs} />
            </LunoraProvider>,
        );

        fireEvent.click(await screen.findByTestId("job-history-load-more"));

        await screen.findByTestId("job-history-row-dead");

        expect(loadJobs).toHaveBeenCalledWith("page-2");
        expect(screen.getByTestId("job-history-row-gone")).toBeDefined();
        expect(screen.queryByTestId("job-history-load-more")).toBeNull();
    });
});
