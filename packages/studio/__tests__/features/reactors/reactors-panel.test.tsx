import { LunoraProvider } from "@lunora/react";
import { render, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import ReactorsPanel from "../../../src/features/reactors/reactors-panel";
import type { ReactorMetadata } from "../../../src/lib/admin";
import type { MockClientHooks } from "../../mock-client";
import { createMockClient } from "../../mock-client";

/**
 * The Reactors panel.
 *
 * Its whole reason to exist is telling three cases apart that look identical
 * from outside the shard: a reactor that has never been dispatched, one that is
 * running, and one that throws on every flush. So these tests assert the
 * classification and the numbers it derives, not the markup around them.
 */
const LISTED = "__lunora_admin__:listReactors";

const reactor = (overrides: Partial<ReactorMetadata> = {}): ReactorMetadata => {
    return {
        errors: 0,
        path: "reactors:dispatch",
        runs: 0,
        state: "idle",
        suppressed: 0,
        ...overrides,
    };
};

const mountWith = (reactors: ReactorMetadata[]): MockClientHooks => {
    const mock = createMockClient({
        query: (reference: string) => (reference === LISTED ? { reactors } : undefined),
    });

    render(
        (
            <LunoraProvider client={mock.asClient}>
                <ReactorsPanel />
            </LunoraProvider>
        ) as ReactElement,
    );

    return mock;
};

describe("reactorsPanel", () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("shows an empty state when nothing is declared", async () => {
        expect.assertions(1);

        mountWith([]);

        // "No reactors declared" is a real answer, not a loading state — it means
        // the app exports no onQueryChange at all.
        const empty = await screen.findByTestId("reactors-empty");

        expect(empty.textContent).toContain("No reactors declared");
    });

    it("renders a declared-but-never-dispatched reactor as idle", async () => {
        expect.assertions(2);

        mountWith([reactor()]);

        const badge = await screen.findByTestId("reactors-state-reactors:dispatch");

        // The state an operator is actually hunting when a reactor "doesn't work":
        // it exists, and nothing has ever asked it to run.
        expect(badge.textContent).toBe("idle");
        // No footprint learned yet, so no tables to show.
        expect(screen.getByTestId("reactors-row-reactors:dispatch").textContent).toContain("—");
    });

    it("renders an active reactor with its counters and watched tables", async () => {
        expect.assertions(3);

        mountWith([reactor({ lastRanAt: 1_700_000_000_000, runs: 4, state: "active", suppressed: 6, tables: ["orders", "desks"] })]);

        const row = await screen.findByTestId("reactors-row-reactors:dispatch");

        expect(screen.getByTestId("reactors-state-reactors:dispatch").textContent).toBe("active");
        expect(row.textContent).toContain("orders, desks");
        // 6 suppressed of 10 dispatches — the ratio that says the select is
        // being re-evaluated by writes it does not care about.
        expect(row.textContent).toContain("60%");
    });

    it("omits the suppression rate for a reactor that has never been dispatched", async () => {
        expect.assertions(1);

        mountWith([reactor()]);

        const row = await screen.findByTestId("reactors-row-reactors:dispatch");

        // `0%` would read as "nothing is being suppressed", which is a claim about
        // a reactor that has produced no data at all.
        expect(row.textContent).not.toContain("%");
    });

    it("surfaces a failing reactor's message above the table", async () => {
        expect.assertions(3);

        mountWith([reactor({ errors: 3, lastError: "orders table is missing", lastRanAt: 1_700_000_000_000, runs: 1, state: "failing" })]);

        const failing = await screen.findByTestId("reactors-failing");

        expect(screen.getByTestId("reactors-state-reactors:dispatch").textContent).toBe("failing");
        // Hoisted out of the row because a failing reactor's baseline is frozen —
        // it is retried on every flush and will keep throwing until fixed.
        expect(failing.textContent).toContain("orders table is missing");
        expect(failing.textContent).toContain("reactors:dispatch");
    });

    it("does not render the failure banner when every reactor is healthy", async () => {
        expect.assertions(1);

        mountWith([reactor({ runs: 2, state: "active" })]);

        await screen.findByTestId("reactors-row-reactors:dispatch");

        expect(screen.queryByTestId("reactors-failing")).toBeNull();
    });

    it("lists several reactors independently", async () => {
        expect.assertions(3);

        mountWith([
            reactor({ path: "reactors:a", runs: 2, state: "active" }),
            reactor({ path: "reactors:b", state: "idle" }),
            reactor({ lastError: "boom", path: "reactors:c", state: "failing" }),
        ]);

        await screen.findByTestId("reactors-row-reactors:a");

        expect(screen.getByTestId("reactors-state-reactors:a").textContent).toBe("active");
        expect(screen.getByTestId("reactors-state-reactors:b").textContent).toBe("idle");
        expect(screen.getByTestId("reactors-state-reactors:c").textContent).toBe("failing");
    });

    it("streams a live update into the table", async () => {
        expect.assertions(2);

        const mock = mountWith([reactor()]);

        const badge = await screen.findByTestId("reactors-state-reactors:dispatch");

        expect(badge.textContent).toBe("idle");

        // The panel subscribes live, so a reactor firing in the background moves
        // the badge with no manual refresh — which is the point of watching it.
        mock.emit(LISTED, { reactors: [reactor({ lastRanAt: 1_700_000_000_000, runs: 1, state: "active" })] });

        const active = await screen.findByText("active");

        expect(active.textContent).toBe("active");
    });
});
