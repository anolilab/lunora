import { LunoraProvider } from "@lunora/react";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { FunctionStatsPanel } from "../../../src/features/functions/function-stats";
import type { FunctionStatsResult } from "../../../src/lib/admin";
import { ADMIN_FUNCTIONS } from "../../../src/lib/admin";
import type { FunctionDescriptor } from "../../../src/lib/types";
import type { MockClientHooks } from "../../mock-client";
import { createMockClient } from "../../mock-client";

const STATS: FunctionStatsResult = {
    functions: [
        // `messages:list` ran more often and more recently; `messages:send` is
        // slower per call and is the only one to have errored.
        { calls: 5, errors: 0, lastCalledAt: 2000, lastErrorAt: null, lastErrorMessage: null, maxDurationMs: 120, path: "messages:list", totalDurationMs: 250 },
        {
            calls: 2,
            errors: 1,
            lastCalledAt: 1000,
            lastErrorAt: 1000,
            lastErrorMessage: "kaboom",
            maxDurationMs: 3000,
            path: "messages:send",
            totalDurationMs: 4000,
        },
    ],
    sinceMs: 1_700_000_000_000,
};

const DESCRIPTORS: FunctionDescriptor[] = [
    { kind: "query", path: "messages:list" },
    { kind: "mutation", path: "messages:send" },
];

const createClient = (stats: FunctionStatsResult = STATS): MockClientHooks =>
    createMockClient({
        query: (reference): unknown => {
            if (reference === ADMIN_FUNCTIONS.getFunctionStats) {
                return stats;
            }

            throw new Error(`unexpected ${reference}`);
        },
    });

const renderPanel = (mock: MockClientHooks) => (
    <LunoraProvider client={mock.asClient}>
        <FunctionStatsPanel functions={DESCRIPTORS} />
    </LunoraProvider>
);

/** Ordered list of function paths as currently rendered — the first cell of each body row (after the header). */
const renderedPaths = (): string[] =>
    screen
        .getAllByRole("row")
        .slice(1)
        .map((row) => within(row).getAllByRole("cell")[0]?.textContent ?? "");

describe("functionStatsPanel", () => {
    it("renders per-function counts, error rate, and latency on mount", async () => {
        expect.assertions(4);

        render(renderPanel(createClient()));

        const row = await screen.findByTestId("fs-row-messages:list");

        // calls 5, errors 0 → "0", avg 250/5 = 50ms, max 120ms.
        expect(row.textContent).toContain("messages:list");
        expect(row.textContent).toContain("50ms");
        expect(row.textContent).toContain("120ms");

        const errored = screen.getByTestId("fs-row-messages:send");

        // 1 error of 2 calls → "1 (50.0%)", avg 4000/2 = 2.00s.
        expect(errored.textContent).toContain("1 (50.0%)");
    });

    it("annotates each row with the function kind from descriptors", async () => {
        expect.assertions(2);

        render(renderPanel(createClient()));

        const row = await screen.findByTestId("fs-row-messages:list");
        const errored = screen.getByTestId("fs-row-messages:send");

        expect(row.textContent).toContain("query");
        expect(errored.textContent).toContain("mutation");
    });

    it("defaults to recent order and re-sorts by most-called / slowest on demand", async () => {
        expect.assertions(3);

        render(renderPanel(createClient()));

        await screen.findByTestId("fs-table");

        // Default "recent": list (lastCalledAt 2000) before send (1000).
        expect(renderedPaths()).toStrictEqual(["messages:list", "messages:send"]);

        // "Most called": list (5) still leads send (2).
        fireEvent.click(screen.getByTestId("fs-sort-calls"));

        expect(renderedPaths()).toStrictEqual(["messages:list", "messages:send"]);

        // "Slowest": send (max 3000) now leads list (120).
        fireEvent.click(screen.getByTestId("fs-sort-slowest"));

        expect(renderedPaths()).toStrictEqual(["messages:send", "messages:list"]);
    });

    it("shows an empty state when no functions have run", async () => {
        expect.assertions(1);

        render(renderPanel(createClient({ functions: [], sinceMs: STATS.sinceMs })));

        const empty = await screen.findByTestId("fs-empty");

        expect(empty.textContent).toContain("No functions have run on this shard yet.");
    });

    it("surfaces an admin error", async () => {
        expect.assertions(1);

        const mock = createMockClient({
            query: () => {
                throw new Error("ADMIN_FORBIDDEN");
            },
        });

        render(
            <LunoraProvider client={mock.asClient}>
                <FunctionStatsPanel functions={DESCRIPTORS} />
            </LunoraProvider>,
        );

        const error = await screen.findByTestId("fs-error");

        // `toContain`, not `toBe`: the alert also carries the "Show in console"
        // affordance (plan 204), so an exact-text assertion pins unrelated chrome.
        expect(error.textContent).toContain("ADMIN_FORBIDDEN");
    });

    it("opens a getFunctionStats subscription on mount (always live)", async () => {
        expect.assertions(1);

        const mock = createClient();

        render(renderPanel(mock));

        await screen.findByTestId("fs-table");

        // No Live toggle: the subscription opens once the mount seed commits a shard.
        await waitFor(() => {
            const ref = mock.subscribe.mock.calls.at(-1)?.[0] as { __lunoraRef: string } | undefined;

            if (ref?.__lunoraRef !== ADMIN_FUNCTIONS.getFunctionStats) {
                throw new Error("not subscribed yet");
            }
        });

        const ref = mock.subscribe.mock.calls.at(-1)?.[0] as { __lunoraRef: string } | undefined;

        expect(ref?.__lunoraRef).toBe(ADMIN_FUNCTIONS.getFunctionStats);
    });
});
