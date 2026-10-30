import { LunoraProvider } from "@lunora/react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ScheduleOutboxJobs } from "../../../src/features/logs/schedule-outbox-jobs";
import type { ScheduleOutboxEntry } from "../../../src/lib/admin";
import { ADMIN_FUNCTIONS } from "../../../src/lib/admin";
import { createMockClient } from "../../mock-client";

const entry = (overrides: Partial<ScheduleOutboxEntry> = {}): ScheduleOutboxEntry => {
    return {
        attempts: 9,
        createdAt: 1_700_000_000_000,
        forever: true,
        id: "job-1",
        nextAttemptAt: 1_700_000_100_000,
        parked: false,
        target: "billing:sync",
        when: 1_700_000_000_000,
        ...overrides,
    };
};

/** A mock whose outbox read answers `entries`, recording every write it receives. */
const outboxClient = (entries: ScheduleOutboxEntry[]): { calls: { args: unknown; reference: string }[]; mock: ReturnType<typeof createMockClient> } => {
    const calls: { args: unknown; reference: string }[] = [];
    const mock = createMockClient({
        query: (reference, args): unknown => {
            if (reference === ADMIN_FUNCTIONS.getScheduleOutbox) {
                return { entries };
            }

            calls.push({ args, reference });

            return reference === ADMIN_FUNCTIONS.dropOutboxEntry ? { dropped: true } : { retried: true };
        },
    });

    return { calls, mock };
};

describe("scheduleOutboxJobs", () => {
    it("shows each waiting job with its state and retry policy", async () => {
        expect.assertions(3);

        const { mock } = outboxClient([entry(), entry({ forever: false, id: "job-2", parked: true, target: undefined })]);

        render(
            <LunoraProvider client={mock.asClient}>
                <ScheduleOutboxJobs />
            </LunoraProvider>,
        );

        const live = await screen.findByTestId("outbox-row-job-1");

        expect(live.textContent).toContain("forever");
        expect(screen.getByTestId("outbox-row-job-2").textContent).toContain("parked");
        // An unreadable envelope still gets a row, so it can be dropped.
        expect(screen.getByTestId("outbox-row-job-2").textContent).toContain("unreadable");
    });

    it("requeues a job by id", async () => {
        expect.assertions(1);

        const { calls, mock } = outboxClient([entry()]);

        render(
            <LunoraProvider client={mock.asClient}>
                <ScheduleOutboxJobs />
            </LunoraProvider>,
        );

        fireEvent.click(await screen.findByTestId("outbox-retry-job-1"));

        await waitFor(() => {
            expect(calls).toStrictEqual([{ args: { id: "job-1" }, reference: ADMIN_FUNCTIONS.retryOutboxEntry }]);
        });
    });

    it("drops a job only after the confirmation click", async () => {
        expect.assertions(2);

        const { calls, mock } = outboxClient([entry()]);

        render(
            <LunoraProvider client={mock.asClient}>
                <ScheduleOutboxJobs />
            </LunoraProvider>,
        );

        fireEvent.click(await screen.findByTestId("outbox-drop-job-1"));

        expect(calls).toStrictEqual([]);

        fireEvent.click(screen.getByTestId("outbox-drop-job-1-confirm"));

        await waitFor(() => {
            expect(calls).toStrictEqual([{ args: { id: "job-1" }, reference: ADMIN_FUNCTIONS.dropOutboxEntry }]);
        });
    });

    it("walks to the next page and back with the cursor the read returned", async () => {
        expect.assertions(3);

        const reads: unknown[] = [];
        const mock = createMockClient({
            query: (_reference, args): unknown => {
                reads.push(args);

                return (args as { cursor?: string }).cursor === undefined
                    ? { entries: [entry()], nextCursor: "0:1700000000000:job-1" }
                    : { entries: [entry({ id: "job-2", parked: true })] };
            },
        });

        render(
            <LunoraProvider client={mock.asClient}>
                <ScheduleOutboxJobs />
            </LunoraProvider>,
        );

        fireEvent.click(await screen.findByTestId("outbox-next-page"));

        await expect(screen.findByTestId("outbox-row-job-2")).resolves.toBeDefined();
        expect(reads).toContainEqual({ cursor: "0:1700000000000:job-1" });

        fireEvent.click(screen.getByTestId("outbox-first-page"));

        await expect(screen.findByTestId("outbox-row-job-1")).resolves.toBeDefined();
    });

    it("says so when nothing is waiting", async () => {
        expect.assertions(1);

        const { mock } = outboxClient([]);

        render(
            <LunoraProvider client={mock.asClient}>
                <ScheduleOutboxJobs />
            </LunoraProvider>,
        );

        await expect(screen.findByTestId("outbox-empty")).resolves.toBeDefined();
    });

    it("does not offer actions while the shard input is ahead of the rows on screen", async () => {
        expect.assertions(4);

        const { calls, mock } = outboxClient([entry()]);

        render(
            <LunoraProvider client={mock.asClient}>
                <ScheduleOutboxJobs initialShardKey="shard-a" />
            </LunoraProvider>,
        );

        await screen.findByTestId("outbox-row-job-1");
        fireEvent.change(screen.getByTestId("outbox-shard-input"), { target: { value: "shard-b" } });

        // Within the debounce window the rows still belong to shard-a, whatever the input says.
        expect(screen.queryByTestId("outbox-retry-job-1")).toBeNull();
        expect(screen.queryByTestId("outbox-drop-job-1")).toBeNull();

        await expect(screen.findByTestId("outbox-retry-job-1")).resolves.toBeDefined();

        expect(calls).toStrictEqual([]);
    });

    it("opens a shard on its first page after the operator left it on a later one", async () => {
        expect.assertions(1);

        const reads: { cursor: string | undefined; shard: unknown }[] = [];
        const mock = createMockClient({
            query: (_reference, args, options): unknown => {
                reads.push({ cursor: (args as { cursor?: string }).cursor, shard: JSON.stringify(options) });

                return (args as { cursor?: string }).cursor === undefined
                    ? { entries: [entry()], nextCursor: "1700000000000:job-1" }
                    : { entries: [entry({ id: "job-2" })] };
            },
        });

        render(
            <LunoraProvider client={mock.asClient}>
                <ScheduleOutboxJobs initialShardKey="shard-a" />
            </LunoraProvider>,
        );

        fireEvent.click(await screen.findByTestId("outbox-next-page"));
        await screen.findByTestId("outbox-row-job-2");

        fireEvent.change(screen.getByTestId("outbox-shard-input"), { target: { value: "shard-b" } });
        await screen.findByTestId("outbox-row-job-1");
        reads.length = 0;

        fireEvent.change(screen.getByTestId("outbox-shard-input"), { target: { value: "shard-a" } });
        // The debounce has to settle on shard-a before anything is read for it.
        await vi.waitFor(() => {
            if (reads.length === 0) {
                throw new Error("shard-a has not been read yet");
            }
        });

        expect(reads.every((read) => read.cursor === undefined)).toBe(true);
    });

    it("keeps the empty state for the first page, and a way back on a later empty one", async () => {
        expect.assertions(3);

        const laterPage = Promise.withResolvers<{ entries: ScheduleOutboxEntry[] }>();
        const mock = createMockClient({
            query: (_reference, args): unknown =>
                (args as { cursor?: string }).cursor === undefined ? { entries: [entry()], nextCursor: "1700000000000:job-1" } : laterPage.promise,
        });

        render(
            <LunoraProvider client={mock.asClient}>
                <ScheduleOutboxJobs />
            </LunoraProvider>,
        );

        fireEvent.click(await screen.findByTestId("outbox-next-page"));
        // Answer the later page and let it render before the empty state is judged.
        await act(async () => {
            laterPage.resolve({ entries: [] });
            await laterPage.promise;
            // A macrotask turn: the hook hands the answer to state across several promise hops.
            await new Promise<void>((resolve) => {
                setTimeout(resolve, 0);
            });
        });

        expect(screen.queryByTestId("outbox-empty")).toBeNull();
        expect(screen.getByTestId("outbox-first-page")).toBeDefined();

        fireEvent.click(screen.getByTestId("outbox-first-page"));

        await expect(screen.findByTestId("outbox-row-job-1")).resolves.toBeDefined();
    });

    it("tells the operator when Retry now found the entry already gone", async () => {
        expect.assertions(1);

        const mock = createMockClient({
            query: (reference): unknown => (reference === ADMIN_FUNCTIONS.getScheduleOutbox ? { entries: [entry()] } : { retried: false }),
        });

        render(
            <LunoraProvider client={mock.asClient}>
                <ScheduleOutboxJobs />
            </LunoraProvider>,
        );

        fireEvent.click(await screen.findByTestId("outbox-retry-job-1"));

        await expect(screen.findByText("That job is no longer in the outbox.")).resolves.toBeDefined();
    });
});
