import type { ScheduleRecord } from "@lunora/client";
import { LunoraProvider } from "@lunora/react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactElement, ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

import { DeadLetterJobs } from "../../../src/features/logs/dead-letter-jobs";
import type { MockClientHooks } from "../../mock-client";
import { createMockClient } from "../../mock-client";

const DLQ_ROW = /^dlq-row-/;

const RECORDS: ScheduleRecord[] = [
    { args: {}, attempts: 2, enqueuedAt: 1, functionPath: "email:send", id: "few", scheduledFor: 2000 },
    { args: {}, attempts: 9, enqueuedAt: 1, functionPath: "report:build", id: "many", pool: "reports", scheduledFor: 1000, shardKey: "tenant-1" },
];

const withProvider = (mock: MockClientHooks, children: ReactNode): ReactElement => <LunoraProvider client={mock.asClient}>{children}</LunoraProvider>;

describe("deadLetterJobs", () => {
    it("renders most-attempted first — the jobs that fought hardest before dying", async () => {
        expect.assertions(2);

        const loadJobs = vi.fn<() => Promise<ScheduleRecord[]>>(async () => RECORDS);

        render(
            withProvider(
                createMockClient(),
                <DeadLetterJobs
                    loadJobs={loadJobs}
                    retryJob={async () => {
                        return { retried: true };
                    }}
                />,
            ),
        );

        await screen.findByTestId("dlq-table");

        const rows = screen.getAllByTestId(DLQ_ROW);

        // Supplied in the opposite order, so this is the sort, not the input.
        expect(rows[0]?.dataset.testid).toBe("dlq-row-many");
        expect(rows[1]?.dataset.testid).toBe("dlq-row-few");
    });

    it("shows the empty state when nothing has been parked", async () => {
        expect.assertions(2);

        render(withProvider(createMockClient(), <DeadLetterJobs loadJobs={async () => []} />));

        await expect(screen.findByTestId("dlq-empty")).resolves.toBeDefined();
        expect(screen.queryByTestId("dlq-table")).toBeNull();
    });

    /**
     * A host that supplies only `loadJobs` is sourcing the queue from somewhere
     * the client cannot write back to, so the recovery actions must not be
     * offered — an enabled Retry/Drop there would act on the wrong backend.
     */
    it("stays read-only for a custom loader with no action handlers", async () => {
        expect.assertions(2);

        render(withProvider(createMockClient(), <DeadLetterJobs loadJobs={async () => RECORDS} />));

        await screen.findByTestId("dlq-table");

        expect(screen.queryByTestId("dlq-retry-many")).toBeNull();
        expect(screen.queryByTestId("dlq-remove-many")).toBeNull();
    });

    it("offers only the handler the host actually supplied", async () => {
        expect.assertions(2);

        render(
            withProvider(
                createMockClient(),
                <DeadLetterJobs
                    loadJobs={async () => RECORDS}
                    retryJob={async () => {
                        return { retried: true };
                    }}
                />,
            ),
        );

        await screen.findByTestId("dlq-table");

        expect(screen.getByTestId("dlq-retry-many")).toBeDefined();
        expect(screen.queryByTestId("dlq-remove-many")).toBeNull();
    });

    it("retries a job and refetches so the row disappears", async () => {
        expect.assertions(3);

        const retryJob = vi.fn<(id: string) => Promise<{ retried: boolean }>>(async () => {
            return { retried: true };
        });
        let remaining = RECORDS;
        const loadJobs = vi.fn<() => Promise<ScheduleRecord[]>>(async () => remaining);

        render(withProvider(createMockClient(), <DeadLetterJobs loadJobs={loadJobs} retryJob={retryJob} />));

        await screen.findByTestId("dlq-table");

        remaining = RECORDS.filter((record) => record.id !== "many");
        fireEvent.click(screen.getByTestId("dlq-retry-many"));

        // A bare condition, not an `expect` — a retried `expect` inside `waitFor`
        // inflates the assertion count and trips `expect.assertions`.
        await waitFor(() => {
            if (screen.queryByTestId("dlq-row-many") !== null) {
                throw new Error("row still present");
            }
        });

        expect(screen.queryByTestId("dlq-row-many")).toBeNull();
        expect(retryJob).toHaveBeenCalledWith("many");
        expect(loadJobs.mock.calls.length).toBeGreaterThan(1);
    });

    // Drop is irreversible, so it sits behind `ConfirmButton`: the first click
    // arms it, the second commits.
    it("requires a confirmation click before dropping a job", async () => {
        expect.assertions(2);

        const removeJob = vi.fn<(id: string) => Promise<{ removed: boolean }>>(async () => {
            return { removed: true };
        });

        render(withProvider(createMockClient(), <DeadLetterJobs loadJobs={async () => RECORDS} removeJob={removeJob} />));

        await screen.findByTestId("dlq-table");

        fireEvent.click(screen.getByTestId("dlq-remove-many"));

        expect(removeJob).not.toHaveBeenCalled();

        fireEvent.click(screen.getByTestId("dlq-remove-many-confirm"));

        await waitFor(() => {
            if (removeJob.mock.calls.length === 0) {
                throw new Error("drop not invoked yet");
            }
        });

        expect(removeJob).toHaveBeenCalledWith("many");
    });

    it("surfaces a failed action in the error banner instead of losing it", async () => {
        expect.assertions(1);

        render(
            withProvider(
                createMockClient(),
                <DeadLetterJobs
                    loadJobs={async () => RECORDS}
                    retryJob={async () => {
                        throw new Error("scheduler unreachable");
                    }}
                />,
            ),
        );

        await screen.findByTestId("dlq-table");

        fireEvent.click(screen.getByTestId("dlq-retry-many"));

        const banner = await screen.findByTestId("dlq-error");

        expect(banner.textContent).toContain("scheduler unreachable");
    });

    it("surfaces a failed read in the same banner", async () => {
        expect.assertions(1);

        render(
            withProvider(
                createMockClient(),
                <DeadLetterJobs
                    loadJobs={async () => {
                        throw new Error("dead-letter read failed");
                    }}
                />,
            ),
        );

        const banner = await screen.findByTestId("dlq-error");

        expect(banner.textContent).toContain("dead-letter read failed");
    });

    // `scheduledFor` is the last-tried instant; a non-finite one must render the
    // placeholder rather than "Invalid Date".
    it("renders a non-finite last-tried timestamp as a placeholder", async () => {
        expect.assertions(1);

        const broken: ScheduleRecord[] = [{ args: {}, attempts: 1, enqueuedAt: 1, functionPath: "x:y", id: "nan", scheduledFor: Number.NaN }];

        render(withProvider(createMockClient(), <DeadLetterJobs loadJobs={async () => broken} />));

        const row = await screen.findByTestId("dlq-row-nan");

        expect(row.textContent).toContain("—");
    });
});
