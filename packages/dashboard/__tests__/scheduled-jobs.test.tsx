import { CirrusProvider } from "@cirrus/react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactElement, ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

import type { ScheduleRecord } from "@cirrus/client";

import { ScheduledJobs } from "../src/scheduled-jobs.js";
import type { MockClientHooks } from "./mock-client.js";
import { createMockClient } from "./mock-client.js";

const SJ_ROW = /^sj-row-/;

const RECORDS: ScheduleRecord[] = [
    { args: {}, enqueuedAt: 1, functionPath: "email:send", id: "b", scheduledFor: 2000 },
    { args: {}, enqueuedAt: 1, functionPath: "report:build", id: "a", scheduledFor: 1000, shardKey: "tenant-1" },
];

const withProvider = (mock: MockClientHooks, children: ReactNode): ReactElement => <CirrusProvider client={mock.asClient}>{children}</CirrusProvider>;

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

        render(withProvider(createMockClient(), <ScheduledJobs loadJobs={async () => []} />));

        const empty = await screen.findByTestId("sj-empty");

        expect(empty).toBeDefined();
    });

    it("hides cancel controls for a custom read-only loader", async () => {
        expect.assertions(1);

        render(withProvider(createMockClient(), <ScheduledJobs loadJobs={async () => RECORDS} />));

        await screen.findByTestId("sj-table");

        expect(screen.queryByTestId("sj-cancel-a")).toBeNull();
    });

    it("cancels a job and refetches", async () => {
        expect.assertions(2);

        const loadJobs = vi.fn<() => Promise<ScheduleRecord[]>>(async () => RECORDS);
        const cancelJob = vi.fn<() => Promise<{ cancelled: boolean }>>(async () => { return { cancelled: true }; });

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

    it("toggling Auto polls the loader on an interval and stops when turned off", async () => {
        expect.assertions(2);

        vi.useFakeTimers();

        try {
            const loadJobs = vi.fn<() => Promise<ScheduleRecord[]>>(async () => RECORDS);

            render(withProvider(createMockClient(), <ScheduledJobs loadJobs={loadJobs} />));

            // Initial mount load resolves.
            await vi.advanceTimersByTimeAsync(0);

            const callsAfterMount = loadJobs.mock.calls.length;

            fireEvent.click(screen.getByTestId("sj-auto"));

            // Two 5s intervals → two more loads.
            await vi.advanceTimersByTimeAsync(10_000);

            expect(loadJobs).toHaveBeenCalledTimes(callsAfterMount + 2);

            fireEvent.click(screen.getByTestId("sj-auto"));
            const callsAtPause = loadJobs.mock.calls.length;

            await vi.advanceTimersByTimeAsync(15_000);

            expect(loadJobs).toHaveBeenCalledTimes(callsAtPause);
        } finally {
            vi.useRealTimers();
        }
    });

    it("live subscribes to the scheduler WS and renders pushed job lists when client-sourced", async () => {
        expect.assertions(3);

        // No custom loadJobs → the panel sources from the client, so Live uses
        // the WebSocket push (not polling).
        const mock = createMockClient({ listScheduledJobs: () => [] });

        render(withProvider(mock, <ScheduledJobs />));

        await screen.findByTestId("sj-empty");

        // The toggle reads "Live" (push) in client-sourced mode.
        expect(screen.getByTestId("sj-auto").textContent).toContain("Live");

        fireEvent.click(screen.getByTestId("sj-auto"));

        expect(mock.subscribeScheduledJobs).toHaveBeenCalledTimes(1);

        // A server push renders the jobs without any HTTP refetch.
        mock.emitJobs([{ args: {}, enqueuedAt: 1, functionPath: "email:send", id: "pushed", scheduledFor: 5000 }]);

        await screen.findByTestId("sj-row-pushed");

        expect(screen.getByTestId("sj-row-pushed")).toBeDefined();
    });

    it("live falls back to polling labels when a custom loadJobs is supplied", async () => {
        expect.assertions(1);

        const mock = createMockClient();

        render(withProvider(mock, <ScheduledJobs loadJobs={async () => RECORDS} />));

        await screen.findByTestId("sj-table");

        // Host owns the transport → no WS push, the toggle reads "Auto".
        expect(screen.getByTestId("sj-auto").textContent).toContain("Auto");
    });

    it("under Live, cancelling does not fire a redundant HTTP refetch (the WS pushes the update)", async () => {
        expect.assertions(2);

        const mock = createMockClient({ listScheduledJobs: () => RECORDS });

        render(withProvider(mock, <ScheduledJobs />));

        await screen.findByTestId("sj-table");
        fireEvent.click(screen.getByTestId("sj-auto")); // Live on (client-sourced → WS push)

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
