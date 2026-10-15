import { LunoraProvider } from "@lunora/react";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, describe, expect, it } from "vitest";

import DashboardsPanel from "../../../src/features/reports/dashboards-panel";
import { ADMIN_FUNCTIONS } from "../../../src/lib/admin";
import type { MockClientHooks } from "../../mock-client";
import { createMockClient } from "../../mock-client";

const NUMERIC_RESULT = {
    columns: ["author", "messages"],
    rowCount: 2,
    rows: [
        { author: "ada", messages: 42 },
        { author: "grace", messages: 31 },
    ],
    truncated: false,
};

/**
 * A deployment with data but no AI binding — the default for these tests, so the
 * chart picker is exercised on the path every no-AI deployment actually takes.
 */
const numericMock = (): MockClientHooks =>
    createMockClient({
        query: (reference): unknown => {
            if (reference === ADMIN_FUNCTIONS.runSql) {
                return NUMERIC_RESULT;
            }

            if (reference === ADMIN_FUNCTIONS.aiAvailable) {
                return { available: false, level: "disabled" };
            }

            throw new Error(`unexpected ${reference}`);
        },
    });

const renderPanel = (mock: MockClientHooks): ReactElement => (
    <LunoraProvider client={mock.asClient}>
        <DashboardsPanel />
    </LunoraProvider>
);

const addWidget = (title: string, sql: string, kind?: string): void => {
    fireEvent.click(screen.getByTestId("dashboards-add"));
    fireEvent.change(screen.getByTestId("dashboards-form-title"), { target: { value: title } });
    fireEvent.change(screen.getByTestId("dashboards-form-sql"), { target: { value: sql } });

    if (kind !== undefined) {
        fireEvent.change(screen.getByTestId("dashboards-form-kind"), { target: { value: kind } });
    }

    fireEvent.click(screen.getByTestId("dashboards-form-save"));
};

/** Add a tile of a given widget kind. `text` fills the body; every other kind fills the query. */
const addTile = (widgetKind: string, title: string, body: string): void => {
    fireEvent.click(screen.getByTestId("dashboards-add"));
    fireEvent.change(screen.getByTestId("dashboards-form-widget-kind"), { target: { value: widgetKind } });
    fireEvent.change(screen.getByTestId("dashboards-form-title"), { target: { value: title } });
    fireEvent.change(screen.getByTestId(widgetKind === "text" ? "dashboards-form-text" : "dashboards-form-sql"), { target: { value: body } });
    fireEvent.click(screen.getByTestId("dashboards-form-save"));
};

const SQL = "SELECT author, COUNT(*) AS messages FROM messages GROUP BY author;";

describe("dashboardsPanel", () => {
    afterEach(() => {
        localStorage.clear();
    });

    it("starts empty, then adds a widget that charts a numeric result", async () => {
        expect.assertions(3);

        render(renderPanel(numericMock()));

        expect(screen.getByTestId("dashboards-empty")).toBeDefined();

        addWidget("Messages by author", "SELECT author, COUNT(*) AS messages FROM messages GROUP BY author;");

        const chart = await screen.findByTestId("sql-chart");

        // evilcharts/Recharts renders into a measured (0-size under jsdom) container,
        // so assert the chart mounted (not the empty-state) rather than its bars.
        expect(chart).toBeDefined();
        expect(screen.queryByTestId("sql-chart-empty")).toBeNull();
    });

    it("draws the chart type the operator picked, with no AI binding", async () => {
        expect.assertions(2);

        render(renderPanel(numericMock()));

        addWidget("Messages over time", SQL, "line");

        const chart = await screen.findByTestId("sql-chart");

        // The headline defect: before this the widget passed no shape at all, so
        // `SqlResultChart` took its "bar" constant arm on every render and the
        // picker's selection was unobservable.
        expect(chart.dataset["chartKind"]).toBe("line");
        // And the affordance that needs a model stays hidden when there is none.
        expect(screen.queryByTestId(/^dashboards-widget-suggest-/u)).toBeNull();
    });

    it("keeps the picked chart type across a remount", async () => {
        expect.assertions(1);

        const view = render(renderPanel(numericMock()));

        addWidget("Persisted area", SQL, "area");
        await screen.findByTestId("sql-chart");

        view.unmount();
        render(renderPanel(numericMock()));

        const chart = await screen.findByTestId("sql-chart");

        expect(chart.dataset["chartKind"]).toBe("area");
    });

    it("applies a suggestion as a choice, so the shape survives a missing series", async () => {
        // `hasAssertions`, not a count: `waitFor` retries its callback, so the
        // inner expectation runs an unpredictable number of times.
        expect.hasAssertions();

        const mock = createMockClient({
            query: (reference): unknown => {
                if (reference === ADMIN_FUNCTIONS.runSql) {
                    return NUMERIC_RESULT;
                }

                if (reference === ADMIN_FUNCTIONS.aiAvailable) {
                    return { available: true, level: "schema" };
                }

                if (reference === ADMIN_FUNCTIONS.aiChartConfig) {
                    // A y column the result does not have. `SqlResultChart` drops a
                    // SUGGESTED shape in that case — but accepting it was a click,
                    // so the widget stores it as a choice and the shape holds.
                    return { result: { chart: { kind: "line", x: "author", y: ["absent"] }, degraded: false } };
                }

                throw new Error(`unexpected ${reference}`);
            },
        });

        render(renderPanel(mock));

        addWidget("Suggested", SQL);
        await screen.findByTestId("sql-chart");

        const [suggest] = screen.getAllByTestId(/^dashboards-widget-suggest-/u);

        fireEvent.click(suggest as HTMLButtonElement);

        await waitFor(() => {
            expect(screen.getByTestId("sql-chart").dataset["chartKind"]).toBe("line");
        });

        const [stored] = JSON.parse(localStorage.getItem("lunora-studio-dashboards") ?? "[]") as { chartKind?: string }[];

        expect(stored?.chartKind).toBe("line");
    });

    it("says so when a suggestion fails, instead of looking like it changed nothing", async () => {
        expect.hasAssertions();

        const mock = createMockClient({
            query: (reference): unknown => {
                if (reference === ADMIN_FUNCTIONS.runSql) {
                    return NUMERIC_RESULT;
                }

                if (reference === ADMIN_FUNCTIONS.aiAvailable) {
                    return { available: true, level: "schema" };
                }

                if (reference === ADMIN_FUNCTIONS.aiChartConfig) {
                    // `inferChart` swallows this and answers `undefined`, which is
                    // also what it answers for "no change" — so without the alert a
                    // failure and a no-op are indistinguishable to the operator.
                    return { result: { degraded: true, reason: "unavailable" } };
                }

                throw new Error(`unexpected ${reference}`);
            },
        });

        render(renderPanel(mock));

        addWidget("Suggested", SQL);
        await screen.findByTestId("sql-chart");

        const [suggest] = screen.getAllByTestId(/^dashboards-widget-suggest-/u);

        fireEvent.click(suggest as HTMLButtonElement);

        await waitFor(() => {
            expect(screen.getByTestId("dashboards-suggest-error")).toBeDefined();
        });
    });

    it("renders all four tile kinds and round-trips them through localStorage", async () => {
        expect.assertions(6);

        const view = render(renderPanel(numericMock()));

        addTile("chart", "As a chart", SQL);
        addTile("kpi", "As a value", SQL);
        addTile("table", "As a table", SQL);
        addTile("text", "A note", "read me");

        await screen.findByTestId("dashboards-kpi");

        expect(screen.getByTestId("sql-chart")).toBeDefined();
        // The first cell of the first row — a KPI query returns one value, and
        // asking the operator to also name the column would be a second field
        // that can only disagree with the query they just wrote.
        expect(screen.getByTestId("dashboards-kpi").textContent).toContain("ada");
        expect(screen.getByTestId("sql-rows")).toBeDefined();
        expect(screen.getByTestId("dashboards-text").textContent).toBe("read me");

        view.unmount();
        render(renderPanel(numericMock()));

        await screen.findByTestId("dashboards-kpi");

        expect(screen.getByTestId("dashboards-text").textContent).toBe("read me");
        expect(screen.getByTestId("sql-rows")).toBeDefined();
    });

    it("never runs a query for a text tile", async () => {
        expect.assertions(1);

        const mock = numericMock();

        render(renderPanel(mock));

        addTile("text", "A note", "read me");
        await screen.findByTestId("dashboards-text");

        // A text tile must not mount the query hook at all — which is why the two
        // card components are separate rather than one with a branch.
        expect(mock.query.mock.calls.filter((call) => call[0].__lunoraRef === ADMIN_FUNCTIONS.runSql)).toHaveLength(0);
    });

    it("reorders tiles from the keyboard, without a drag", async () => {
        expect.hasAssertions();

        render(renderPanel(numericMock()));

        addTile("text", "First", "one");
        addTile("text", "Second", "two");

        const grid = await screen.findByTestId("dashboards-grid");

        // `draggable` and the drag handlers are pointer-only, so this is the ONLY
        // path a keyboard-only operator has to reorder a dashboard.
        const down = within(grid).getAllByTestId<HTMLButtonElement>(/^dashboards-move-down-/u);

        expect(down[0]?.disabled).toBe(false);
        // The last tile cannot move down — disabled rather than hidden, so the
        // control does not shift under the focus ring as the list changes.
        expect(down.at(-1)?.disabled).toBe(true);

        fireEvent.click(down[0] as HTMLElement);

        await waitFor(() => {
            const stored = JSON.parse(localStorage.getItem("lunora-studio-dashboards") ?? "[]") as { title: string }[];

            expect(stored.map((widget) => widget.title)).toStrictEqual(["Second", "First"]);
        });
    });

    it("reorders tiles by drag and persists the new order", async () => {
        expect.hasAssertions();

        render(renderPanel(numericMock()));

        addTile("text", "First", "one");
        addTile("text", "Second", "two");

        const grid = await screen.findByTestId("dashboards-grid");
        // The tile cards, not the per-tile controls that share the prefix. Ids are
        // `crypto.randomUUID()` in jsdom, so there is no stable id to match on.
        const [first, second] = within(grid).getAllByTestId(/^dashboards-widget-(?!edit-|error-|loading-|remove-|suggest-)/u);

        fireEvent.dragStart(second as HTMLElement);
        fireEvent.drop(first as HTMLElement);

        await waitFor(() => {
            const stored = JSON.parse(localStorage.getItem("lunora-studio-dashboards") ?? "[]") as { title: string }[];

            expect(stored.map((widget) => widget.title)).toStrictEqual(["Second", "First"]);
        });
    });

    it("surfaces a per-widget query error inline", async () => {
        expect.assertions(1);

        const mock = createMockClient({
            query: () => {
                throw new Error("the SQL editor is read-only — only SELECT / WITH / EXPLAIN queries are allowed");
            },
        });

        render(renderPanel(mock));

        addWidget("Broken", "DELETE FROM messages;");

        const error = await screen.findByText(/read-only/);

        expect(error.textContent).toContain("read-only");
    });

    it("removes a widget", async () => {
        expect.hasAssertions();

        render(renderPanel(numericMock()));

        addWidget("Removable", "SELECT author, COUNT(*) AS messages FROM messages GROUP BY author;");

        const grid = await screen.findByTestId("dashboards-grid");

        expect(within(grid).getAllByTestId("sql-chart")).toHaveLength(1);

        const [remove] = within(grid).getAllByTestId(/^dashboards-widget-remove-/u);

        fireEvent.click(remove as HTMLButtonElement);

        await waitFor(() => {
            expect(screen.getByTestId("dashboards-empty")).toBeDefined();
        });
    });

    it("persists widgets to localStorage across a remount", async () => {
        expect.assertions(2);

        const view = render(renderPanel(numericMock()));

        addWidget("Persisted", "SELECT author, COUNT(*) AS messages FROM messages GROUP BY author;");
        await screen.findByTestId("sql-chart");

        const stored = JSON.parse(localStorage.getItem("lunora-studio-dashboards") ?? "[]") as unknown[];

        expect(stored).toHaveLength(1);

        view.unmount();

        render(renderPanel(numericMock()));

        // The widget reloads from localStorage on the fresh mount and re-runs its
        // query, charting the numeric result (the evilcharts chart, not the empty state).
        await screen.findByTestId("sql-chart");

        expect(screen.queryByTestId("sql-chart-empty")).toBeNull();
    });
});
