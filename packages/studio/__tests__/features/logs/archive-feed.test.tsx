import type { PipelineLogPage, PipelineLogRow } from "@lunora/client";
import { LunoraProvider } from "@lunora/react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ArchiveFeed } from "../../../src/features/logs/archive-feed";
import type { MockClientHooks } from "../../mock-client";
import { createMockClient } from "../../mock-client";

const ROW = (overrides: Partial<PipelineLogRow> = {}): PipelineLogRow => {
    return {
        functionPath: "messages:list",
        level: "error",
        message: "boom",
        ts: 1_700_000_005_000,
        ...overrides,
    };
};

/** A mock whose `queryLogArchive` returns `page` (or a fresh page per call from `pages`). */
const createClient = (page: PipelineLogPage): MockClientHooks =>
    createMockClient({
        queryLogArchive: (): PipelineLogPage => page,
    });

const renderFeed = (mock: MockClientHooks) => (
    <LunoraProvider client={mock.asClient}>
        <ArchiveFeed shardKey="" />
    </LunoraProvider>
);

describe("archiveFeed", () => {
    it("fetches a page and renders its rows", async () => {
        expect.assertions(2);

        const mock = createClient({ rows: [ROW({ ts: 1 }), ROW({ functionPath: "auth:login", ts: 2 })] });

        render(renderFeed(mock));

        await waitFor(() => {
            expect(screen.getByTestId("lg-archive-table")).toBeDefined();
        });

        const table = screen.getByTestId("lg-archive-table");

        expect(table.textContent).toContain("auth:login");
    });

    it("shows Load more only when a nextCursor is present, and appends the next page on click", async () => {
        expect.assertions(3);

        const first: PipelineLogPage = { nextCursor: { ts: 1_699_999_000_000 }, rows: [ROW({ message: "first", ts: 10 })] };
        const second: PipelineLogPage = { rows: [ROW({ message: "second", ts: 5 })] };
        const pages = [first, second];

        const mock = createMockClient({
            queryLogArchive: (): PipelineLogPage => pages.shift() ?? { rows: [] },
        });

        render(renderFeed(mock));

        const more = await screen.findByTestId("lg-archive-more");

        expect(more).toBeDefined();

        fireEvent.click(more);

        // `findByText` waits for the re-render without an assertion inside a retrying
        // `waitFor` (which would double-count against `expect.assertions`).
        await screen.findByText("second");

        const text = screen.getByTestId("lg-archive-table").textContent;

        expect(text).toContain("second");
        // The first page's row is still there (appended, not replaced).
        expect(text).toContain("first");
    });

    it("renders the empty state when the archive returns no rows", async () => {
        expect.assertions(1);

        render(renderFeed(createClient({ rows: [] })));

        await waitFor(() => {
            expect(screen.getByTestId("lg-archive-empty")).toBeDefined();
        });
    });

    it("renders the not-configured state (not an error) when the server reports LOG_ARCHIVE_NOT_CONFIGURED", async () => {
        expect.assertions(2);

        const mock = createMockClient({
            queryLogArchive: (): PipelineLogPage => {
                throw Object.assign(new Error("log archive not configured"), { code: "LOG_ARCHIVE_NOT_CONFIGURED" });
            },
        });

        render(renderFeed(mock));

        await waitFor(() => {
            expect(screen.getByTestId("lg-archive-not-configured")).toBeDefined();
        });

        // A misconfiguration is an empty state, never the red error line.
        expect(screen.queryByTestId("lg-archive-error")).toBeNull();
    });

    it("surfaces a genuine error inline", async () => {
        expect.assertions(1);

        const mock = createMockClient({
            queryLogArchive: (): PipelineLogPage => {
                throw new Error("r2 sql exploded");
            },
        });

        render(renderFeed(mock));

        await waitFor(() => {
            expect(screen.getByTestId("lg-archive-error").textContent).toContain("r2 sql exploded");
        });
    });
});
