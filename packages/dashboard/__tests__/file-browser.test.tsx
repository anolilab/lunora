import type { StorageListPage } from "@cirrus/client";
import { CirrusProvider } from "@cirrus/react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import { describe, expect, test } from "vitest";

import { FileBrowser } from "../src/file-browser.js";
import { createMockClient, type MockClientHooks } from "./mock-client.js";

const PAGE_ONE: StorageListPage = {
    cursor: "c1",
    objects: [
        { etag: "e1", httpMetadata: { contentType: "image/png" }, key: "avatars/a.png", size: 2048 },
        { etag: "e2", key: "avatars/b.txt", size: 12 },
    ],
};

const PAGE_TWO: StorageListPage = {
    objects: [{ etag: "e3", key: "avatars/c.bin", size: 1_048_576 }],
};

const createClient = (): MockClientHooks =>
    createMockClient({
        listStorageObjects: (options): StorageListPage => {
            return options.cursor === "c1" ? PAGE_TWO : PAGE_ONE;
        },
    });

const renderBrowser = (mock: MockClientHooks): ReactElement => (
    <CirrusProvider client={mock.asClient}>
        <FileBrowser />
    </CirrusProvider>
);

describe("fileBrowser", () => {
    test("lists objects with formatted sizes on mount", async () => {
        render(renderBrowser(createClient()));

        await waitFor(() => {
            expect(screen.getByTestId("fb-table")).toBeDefined();
        });

        const rows = screen.getAllByTestId("fb-row");

        expect(rows).toHaveLength(2);
        expect(rows[0]?.textContent).toContain("avatars/a.png");
        expect(rows[0]?.textContent).toContain("2.0 KB");
        expect(rows[0]?.textContent).toContain("image/png");
    });

    test("forwards the prefix when listing", async () => {
        const mock = createClient();

        render(renderBrowser(mock));

        await waitFor(() => {
            expect(screen.getByTestId("fb-table")).toBeDefined();
        });

        fireEvent.change(screen.getByTestId("fb-prefix-input"), { target: { value: "avatars/" } });
        fireEvent.click(screen.getByTestId("fb-list"));

        await waitFor(() => {
            expect(mock.listStorageObjects.mock.calls.length).toBeGreaterThan(1);
        });

        const lastCall = mock.listStorageObjects.mock.calls.at(-1) as [{ prefix?: string }];

        expect(lastCall[0]).toMatchObject({ prefix: "avatars/" });
    });

    test("appends the next page via the cursor", async () => {
        render(renderBrowser(createClient()));

        await waitFor(() => {
            expect(screen.getByTestId("fb-next")).toBeDefined();
        });

        fireEvent.click(screen.getByTestId("fb-next"));

        await waitFor(() => {
            expect(screen.getAllByTestId("fb-row")).toHaveLength(3);
        });

        // The final page has no cursor, so "Load more" disappears.
        expect(screen.queryByTestId("fb-next")).toBeNull();
    });

    test("surfaces a listing error", async () => {
        const mock = createMockClient({
            listStorageObjects: () => {
                throw new Error("STORAGE_NOT_CONFIGURED");
            },
        });

        render(renderBrowser(mock));

        await waitFor(() => {
            expect(screen.getByTestId("fb-error").textContent).toBe("STORAGE_NOT_CONFIGURED");
        });
    });
});
