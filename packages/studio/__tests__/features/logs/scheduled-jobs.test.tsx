import type { ScheduleRecord } from "@cirrus/client";
import { CirrusProvider } from "@cirrus/react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactElement, ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

import { ScheduledJobs } from "../../../src/features/logs/scheduled-jobs";
import type { MockClientHooks } from "../../mock-client";
import { createMockClient } from "../../mock-client";

const SJ_ROW = /^sj-row-/;

const RECORDS: ScheduleRecord[] = [
    { args: {}, enqueuedAt: 1, functionPath: "email:send", id: "b", scheduledFor: 2000 },
    { args: {}, enqueuedAt: 1, functionPath: "report:build", id: "a", scheduledFor: 1000, shardKey: "tenant-1" },
];

const withProvider = (mock: MockClientHooks, children: ReactNode): ReactElement => <CirrusProvider client={mock.asClient}>{children}</CirrusProvider>;

const loadEmpty = async (): Promise<ScheduleRecord[]> => [];
const loadRecords = async (): Promise<ScheduleRecord[]> => RECORDS;

describe("scheduledJobs", () => {
    it("renders jobs soonest-due first", async () => {
        expect.assertions(2);

        const loadJobs = vi.fn<() => Promise<ScheduleRecord[]>>(async () => RECORDS);

        render(withProvider(createMockClient(), <ScheduledJobs loadJobs={loadJobs} />));

        await screen.findByTestId("sj-table");

        const rows = screen.getAllByTestId(SJ_ROW);

        expect(rows[0]?.dataset.testid).toBe("sj-row-a");
        expect(rows[1]?.dataset.testid).toBe("sj-row-b");
    });

    it("shows empty state when there are no jobs", async () => {
        expect.assertions(1);

        render(withProvider(createMockClient(), <ScheduledJobs loadJobs={loadEmpty} />));

        const empty = await screen.findByTestId("sj-empty");

        expect(empty).toBeDefined();
    });

    it("hides cancel controls for a custom read-only loader", async () => {
        expect.assertions(1);

        render(withProvider(createMockClient(), <ScheduledJobs loadJobs={loadRecords} />));

        await screen.findByTestId("sj-table");

        expect(screen.queryByTestId("sj-cancel-a")).toBeNull();
    });

    it("cancels a job and refetches", async () => {
        expect.assertions(2);

        const loadJobs = vi.fn<() => Promise<ScheduleRecord[]>>(async () => RECORDS);
        const cancelJob = vi.fn<() => Promise<{ cancelled: boolean }>>(async () => {
            return { cancelled: true };
        });

        render(withProvider(createMockClient(), <ScheduledJobs cancelJob={cancelJob} loadJobs={loadJobs} />));

        fireEvent.click(await screen.findByTestId("sj-cancel-a"));
        fireEvent.click(screen.getByTestId("sj-cancel-a-confirm"));

        await waitFor(() => {
            if (cancelJob.mock.calls.length === 0) {
                throw new Error("cancelJob not called yet");
            }
        });

        expect(cancelJob).toHaveBeenCalledWith("a");

        await waitFor(() => {
            if (loadJobs.mock.calls.length < 2) {
                throw new Error("jobs not refetched yet");
            }
        });

        expect(loadJobs.mock.calls.length).toBeGreaterThanOrEqual(2);
    });

    it("falls back to the client's scheduler admin methods", async () => {
        expect.assertions(2);

        const mock = createMockClient({ listScheduledJobs: () => RECORDS });

        render(withProvider(mock, <ScheduledJobs />));

        await screen.findByTestId("sj-cancel-a");

        expect(mock.listScheduledJobs).toHaveBeenCalledWith();

        fireEvent.click(screen.getByTestId("sj-cancel-a"));
        fireEvent.click(screen.getByTestId("sj-cancel-a-confirm"));

        await waitFor(() => {
            if (mock.cancelScheduledJob.mock.calls.length === 0) {
                throw new Error("cancelScheduledJob not called yet");
            }
        });

        expect(mock.cancelScheduledJob).toHaveBeenCalledWith("a");
    });

    it("polls a custom loader on an interval (always on, no toggle)", async () => {
        expect.assertions(1);

        vi.useFakeTimers();

        try {
            const loadJobs = vi.fn<() => Promise<ScheduleRecord[]>>(async () => RECORDS);

            render(withProvider(createMockClient(), <ScheduledJobs loadJobs={loadJobs} />));

            // Initial mount load resolves.
            await vi.advanceTimersByTimeAsync(0);

            const callsAfterMount = loadJobs.mock.calls.length;

            // No Auto toggle: a custom loader (no WS) polls on its own.
            // Two 5s intervals → two more loads.
            await vi.advanceTimersByTimeAsync(10_000);

            expect(loadJobs).toHaveBeenCalledTimes(callsAfterMount + 2);
        } finally {
            vi.useRealTimers();
        }
    });

    it("subscribes to the scheduler WS on mount and renders pushed job lists when client-sourced", async () => {
        expect.assertions(2);

        // No custom loadJobs → the panel sources from the client, so it uses the
        // WebSocket push (not polling), always on.
        const mock = createMockClient({ listScheduledJobs: () => [] });

        render(withProvider(mock, <ScheduledJobs />));

        await screen.findByTestId("sj-empty");

        // No toggle: the WS subscription opens on mount in client-sourced mode.
        await waitFor(() => {
            if (mock.subscribeScheduledJobs.mock.calls.length === 0) {
                throw new Error("not subscribed yet");
            }
        });

        expect(mock.subscribeScheduledJobs).toHaveBeenCalledTimes(1);

        // A server push renders the jobs without any HTTP refetch.
        mock.emitJobs([{ args: {}, enqueuedAt: 1, functionPath: "email:send", id: "pushed", scheduledFor: 5000 }]);

        await screen.findByTestId("sj-row-pushed");

        expect(screen.getByTestId("sj-row-pushed")).toBeDefined();
    });

    it("cancelling does not fire a redundant HTTP refetch when client-sourced (the WS pushes the update)", async () => {
        expect.assertions(2);

        const mock = createMockClient({ listScheduledJobs: () => RECORDS });

        render(withProvider(mock, <ScheduledJobs />));

        await screen.findByTestId("sj-table");

        const listCallsBefore = mock.listScheduledJobs.mock.calls.length;

        // Cancel a job, then confirm the inline ConfirmButton.
        fireEvent.click(screen.getByTestId("sj-cancel-a"));
        fireEvent.click(screen.getByTestId("sj-cancel-a-confirm"));

        await waitFor(() => {
            if (mock.cancelScheduledJob.mock.calls.length === 0) {
                throw new Error("cancel not called yet");
            }
        });

        // The cancel went through…
        expect(mock.cancelScheduledJob).toHaveBeenCalledWith("a");
        // …but no extra listScheduledJobs() refetch fired — the WS push covers it.
        expect(mock.listScheduledJobs).toHaveBeenCalledTimes(listCallsBefore);
    });
});
