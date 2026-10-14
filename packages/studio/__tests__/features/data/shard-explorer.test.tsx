import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ShardExplorer } from "../../../src/features/data/shard-explorer";
import type { TableInfo } from "../../../src/lib/admin";

// ── Module mock: control loadRecentShards across tests ───────────────────────

vi.mock(import("../../../src/lib/shard-history"), async (importOriginal) => {
    const mod = await importOriginal();

    return {
        ...mod,
        loadRecentShards: vi.fn<() => string[]>(() => []),
        recordShard: vi.fn<(key: string) => string[]>(() => []),
    };
});

const { loadRecentShards } = await import("../../../src/lib/shard-history");

// ── Fixture table list ───────────────────────────────────────────────────────

const TABLES: TableInfo[] = [
    { name: "posts", rowCount: 42 },
    { name: "users", rowCount: 7 },
];

// ── Render helpers ───────────────────────────────────────────────────────────

const makeOnFetchTables = (tables: TableInfo[] = TABLES) => vi.fn<(shardKey: string) => Promise<ReadonlyArray<TableInfo> | undefined>>(async () => tables);

const renderExplorer = ({ onFetchTables = makeOnFetchTables(), onSelect = vi.fn<(shardKey: string) => void>() } = {}) =>
    render(<ShardExplorer onFetchTables={onFetchTables} onSelect={onSelect} />);

// ── Tests ────────────────────────────────────────────────────────────────────

describe("shardExplorer", () => {
    it("renders nothing when there are no recent shards", () => {
        expect.assertions(1);

        vi.mocked(loadRecentShards).mockReturnValue([]);

        renderExplorer();

        expect(screen.queryByTestId("shard-explorer")).toBeNull();
    });

    it("renders the toggle button when recent shards exist", () => {
        expect.assertions(1);

        vi.mocked(loadRecentShards).mockReturnValue(["shard-a"]);

        renderExplorer();

        expect(screen.getByTestId("shard-explorer-toggle").tagName.toLowerCase()).toBe("button");
    });

    it("hides the panel initially", () => {
        expect.assertions(1);

        vi.mocked(loadRecentShards).mockReturnValue(["shard-a"]);

        renderExplorer();

        expect(screen.queryByTestId("shard-explorer-panel")).toBeNull();
    });

    it("shows the panel when the toggle is clicked", () => {
        expect.assertions(1);

        vi.mocked(loadRecentShards).mockReturnValue(["shard-a"]);

        renderExplorer();

        fireEvent.click(screen.getByTestId("shard-explorer-toggle"));

        expect(screen.getByTestId("shard-explorer-panel").tagName.toLowerCase()).toBe("div");
    });

    it("renders a button for each recent shard", () => {
        expect.assertions(2);

        vi.mocked(loadRecentShards).mockReturnValue(["shard-a", "shard-b"]);

        renderExplorer();

        fireEvent.click(screen.getByTestId("shard-explorer-toggle"));

        expect(screen.getByTestId("shard-explorer-item-shard-a").tagName.toLowerCase()).toBe("button");
        expect(screen.getByTestId("shard-explorer-item-shard-b").tagName.toLowerCase()).toBe("button");
    });

    it("calls onSelect when a shard button is clicked", () => {
        expect.assertions(1);

        vi.mocked(loadRecentShards).mockReturnValue(["shard-a"]);

        const onSelect = vi.fn<(shardKey: string) => void>();

        renderExplorer({ onSelect });

        fireEvent.click(screen.getByTestId("shard-explorer-toggle"));
        fireEvent.click(screen.getByTestId("shard-explorer-item-shard-a"));

        expect(onSelect).toHaveBeenCalledWith("shard-a");
    });

    it("calls onFetchTables with the selected shard key", async () => {
        expect.hasAssertions();

        vi.mocked(loadRecentShards).mockReturnValue(["shard-a"]);

        const onFetchTables = makeOnFetchTables();

        renderExplorer({ onFetchTables });

        fireEvent.click(screen.getByTestId("shard-explorer-toggle"));
        fireEvent.click(screen.getByTestId("shard-explorer-item-shard-a"));

        await waitFor(() => {
            expect(onFetchTables).toHaveBeenCalledWith("shard-a");
        });
    });

    it("shows the summary section after a shard is selected", async () => {
        expect.hasAssertions();

        vi.mocked(loadRecentShards).mockReturnValue(["shard-a"]);

        renderExplorer();

        fireEvent.click(screen.getByTestId("shard-explorer-toggle"));
        fireEvent.click(screen.getByTestId("shard-explorer-item-shard-a"));

        await waitFor(() => {
            expect(screen.getByTestId("shard-explorer-summary").tagName.toLowerCase()).toBe("div");
        });
    });

    it("renders a row for each table in the summary", async () => {
        expect.hasAssertions();

        vi.mocked(loadRecentShards).mockReturnValue(["shard-a"]);

        renderExplorer({ onFetchTables: makeOnFetchTables(TABLES) });

        fireEvent.click(screen.getByTestId("shard-explorer-toggle"));
        fireEvent.click(screen.getByTestId("shard-explorer-item-shard-a"));

        await waitFor(() => {
            expect(screen.getByTestId("shard-explorer-table-posts").textContent).toBe("posts");
            expect(screen.getByTestId("shard-explorer-rowcount-posts").textContent).toBe("42");
        });
    });

    it("shows the empty state when the shard has no tables", async () => {
        expect.hasAssertions();

        vi.mocked(loadRecentShards).mockReturnValue(["shard-a"]);

        renderExplorer({ onFetchTables: makeOnFetchTables([]) });

        fireEvent.click(screen.getByTestId("shard-explorer-toggle"));
        fireEvent.click(screen.getByTestId("shard-explorer-item-shard-a"));

        await waitFor(() => {
            expect(screen.getByTestId("shard-explorer-empty").tagName.toLowerCase()).toBe("p");
        });
    });

    it("shows an error when onFetchTables rejects", async () => {
        expect.hasAssertions();

        vi.mocked(loadRecentShards).mockReturnValue(["shard-a"]);

        const onFetchTables = vi.fn<(shardKey: string) => Promise<ReadonlyArray<TableInfo> | undefined>>(async () => {
            throw new Error("fetch failed");
        });

        renderExplorer({ onFetchTables });

        fireEvent.click(screen.getByTestId("shard-explorer-toggle"));
        fireEvent.click(screen.getByTestId("shard-explorer-item-shard-a"));

        await waitFor(() => {
            expect(screen.getByTestId("shard-explorer-error").textContent).toContain("fetch failed");
        });
    });

    it("collapses the panel when the toggle is clicked again", () => {
        expect.assertions(1);

        vi.mocked(loadRecentShards).mockReturnValue(["shard-a"]);

        renderExplorer();

        fireEvent.click(screen.getByTestId("shard-explorer-toggle"));
        fireEvent.click(screen.getByTestId("shard-explorer-toggle"));

        expect(screen.queryByTestId("shard-explorer-panel")).toBeNull();
    });
});
