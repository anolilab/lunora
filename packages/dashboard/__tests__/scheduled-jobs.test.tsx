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
        expect.assertions(2);

        const loadJobs = vi.fn(async () => RECORDS);

        render(withProvider(createMockClient(), <ScheduledJobs loadJobs={loadJobs} />));

        await screen.findByTestId("sj-table");

        const rows = screen.getAllByTestId(/^sj-row-/);

        expect(rows[0]?.dataset.testid).toBe("sj-row-a");
        expect(rows[1]?.dataset.testid).toBe("sj-row-b");
    });

    test("shows empty state when there are no jobs", async () => {
        expect.assertions(1);

        render(withProvider(createMockClient(), <ScheduledJobs loadJobs={async () => []} />));

        const empty = await screen.findByTestId("sj-empty");

        expect(empty).toBeDefined();
    });

    test("hides cancel controls for a custom read-only loader", async () => {
        expect.assertions(1);

        render(withProvider(createMockClient(), <ScheduledJobs loadJobs={async () => RECORDS} />));

        await screen.findByTestId("sj-table");

        expect(screen.queryByTestId("sj-cancel-a")).toBeNull();
    });

    test("cancels a job and refetches", async () => {
        expect.assertions(2);

        const loadJobs = vi.fn(async () => RECORDS);
        const cancelJob = vi.fn(async () => ({ cancelled: true }));

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

    test("falls back to the client's scheduler admin methods", async () => {
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

    test("toggling Auto polls the loader on an interval and stops when turned off", async () => {
        vi.useFakeTimers();

        try {
            const loadJobs = vi.fn(async () => RECORDS);

            render(withProvider(createMockClient(), <ScheduledJobs loadJobs={loadJobs} />));

            // Initial mount load resolves.
            await vi.advanceTimersByTimeAsync(0);

            const callsAfterMount = loadJobs.mock.calls.length;

            fireEvent.click(screen.getByTestId("sj-auto"));

            // Two 5s intervals → two more loads.
            await vi.advanceTimersByTimeAsync(10_000);

            expect(loadJobs.mock.calls.length).toBe(callsAfterMount + 2);

            fireEvent.click(screen.getByTestId("sj-auto"));
            const callsAtPause = loadJobs.mock.calls.length;

            await vi.advanceTimersByTimeAsync(15_000);

            expect(loadJobs.mock.calls.length).toBe(callsAtPause);
        } finally {
            vi.useRealTimers();
        }
    });

    test("Live subscribes to the scheduler WS and renders pushed job lists when client-sourced", async () => {
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

    test("Live falls back to polling labels when a custom loadJobs is supplied", async () => {
        expect.assertions(1);

        const mock = createMockClient();

        render(withProvider(mock, <ScheduledJobs loadJobs={async () => RECORDS} />));

        await screen.findByTestId("sj-table");

        // Host owns the transport → no WS push, the toggle reads "Auto".
        expect(screen.getByTestId("sj-auto").textContent).toContain("Auto");
    });
});
