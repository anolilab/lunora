import type { StorageListPage } from "@cirrus/client";
import { CirrusProvider } from "@cirrus/react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { FileBrowser } from "../src/file-browser";
import type { MockClientHooks } from "./mock-client";
import { createMockClient } from "./mock-client";

const PAGE_ONE: StorageListPage = {
    cursor: "c1",
    objects: [
        { etag: "e1", httpMetadata: { contentType: "image/png" }, key: "a.png", size: 2048 },
        { etag: "e2", key: "b.txt", size: 12 },
    ],
};

const PAGE_TWO: StorageListPage = {
    objects: [{ etag: "e3", key: "c.bin", size: 1_048_576 }],
};

const createClient = (): MockClientHooks =>
    createMockClient({
        listStorageObjects: (options): StorageListPage => (options.cursor === "c1" ? PAGE_TWO : PAGE_ONE),
    });

// A nested listing — two sub-folders plus a root-level file — for folder navigation.
const NESTED_PAGE: StorageListPage = {
    objects: [
        { etag: "n1", key: "docs/readme.md", size: 100 },
        { etag: "n2", key: "images/logo.png", size: 200 },
        { etag: "n3", key: "root.txt", size: 50 },
    ],
};

const DOCS_PAGE: StorageListPage = {
    objects: [{ etag: "d1", key: "docs/guide.md", size: 300 }],
};

const renderBrowser = (mock: MockClientHooks): ReactElement => (
    <CirrusProvider client={mock.asClient}>
        <FileBrowser />
    </CirrusProvider>
);

describe("fileBrowser", () => {
    it("lists objects with formatted sizes on mount", async () => {
        expect.assertions(4);

        render(renderBrowser(createClient()));

        await screen.findByTestId("fb-table");

        const rows = screen.getAllByTestId("fb-row");

        expect(rows).toHaveLength(2);
        expect(rows[0]?.textContent).toContain("a.png");
        expect(rows[0]?.textContent).toContain("2.0 KB");
        expect(rows[0]?.textContent).toContain("image/png");
    });

    it("forwards the prefix when listing", async () => {
        expect.assertions(1);

        const mock = createClient();

        render(renderBrowser(mock));

        await screen.findByTestId("fb-table");

        fireEvent.change(screen.getByTestId("fb-prefix-input"), { target: { value: "avatars/" } });
        fireEvent.click(screen.getByTestId("fb-list"));

        await waitFor(() => {
            if (mock.listStorageObjects.mock.calls.length <= 1) {
                throw new Error("not relisted yet");
            }
        });

        const lastCall = mock.listStorageObjects.mock.calls.at(-1) as [{ prefix?: string }];

        expect(lastCall[0]).toMatchObject({ prefix: "avatars/" });
    });

    it("appends the next page via the cursor", async () => {
        expect.assertions(1);

        render(renderBrowser(createClient()));

        fireEvent.click(await screen.findByTestId("fb-next"));

        await waitFor(() => {
            if (screen.getAllByTestId("fb-row").length !== 3) {
                throw new Error("next page not appended yet");
            }
        });

        // The final page has no cursor, so "Load more" disappears.
        expect(screen.queryByTestId("fb-next")).toBeNull();
    });

    it("surfaces a listing error", async () => {
        expect.assertions(1);

        const mock = createMockClient({
            listStorageObjects: () => {
                throw new Error("STORAGE_NOT_CONFIGURED");
            },
        });

        render(renderBrowser(mock));

        const error = await screen.findByTestId("storage-error");

        expect(error.textContent).toBe("STORAGE_NOT_CONFIGURED");
    });

    it("groups nested keys into folders and navigates into one", async () => {
        expect.assertions(4);

        const mock = createMockClient({
            listStorageObjects: (options): StorageListPage => (options.prefix === "docs/" ? DOCS_PAGE : NESTED_PAGE),
        });

        render(renderBrowser(mock));

        await screen.findByTestId("fb-table");

        // At root: two sub-folders (docs/, images/) + one root-level file.
        expect(screen.getAllByTestId("fb-folder")).toHaveLength(2);
        expect(screen.getAllByTestId("fb-row")).toHaveLength(1);

        // Folders sort alphabetically, so the first is docs/ — descend into it.
        fireEvent.click(screen.getAllByTestId("fb-folder")[0] as HTMLElement);

        await waitFor(() => {
            if (!mock.listStorageObjects.mock.calls.some((call) => (call[0] as { prefix?: string }).prefix === "docs/")) {
                throw new Error("not navigated into docs/ yet");
            }
        });

        const lastCall = mock.listStorageObjects.mock.calls.at(-1) as [{ prefix?: string }];

        expect(lastCall[0]).toMatchObject({ prefix: "docs/" });
        // Inside docs/, guide.md shows as a file named relative to the folder.
        const fileRow = await screen.findByTestId("fb-row");

        expect(fileRow.textContent).toContain("guide.md");
    });

    describe("mutations", () => {
        beforeEach(() => {
            Object.defineProperty(globalThis.navigator, "clipboard", {
                configurable: true,
                value: { writeText: vi.fn<(text: string) => Promise<void>>(async () => undefined) },
            });
        });

        it("deletes a row after confirming and refreshes the listing", async () => {
            expect.assertions(2);

            const mock = createClient();

            render(renderBrowser(mock));

            await screen.findByTestId("fb-table");

            // First click arms the ConfirmButton; the confirm step fires the delete.
            fireEvent.click(screen.getByTestId("storage-delete-a.png"));
            fireEvent.click(screen.getByTestId("storage-delete-a.png-confirm"));

            await waitFor(() => {
                if (mock.deleteStorageObject.mock.calls.length === 0) {
                    throw new Error("not deleted yet");
                }
            });

            expect(mock.deleteStorageObject).toHaveBeenCalledWith("a.png");

            // The post-delete re-list re-calls listStorageObjects (mount + refresh).
            await waitFor(() => {
                if (mock.listStorageObjects.mock.calls.length < 2) {
                    throw new Error("not relisted yet");
                }
            });

            expect(mock.listStorageObjects.mock.calls.length).toBeGreaterThanOrEqual(2);
        });

        it("copies a signed URL to the clipboard", async () => {
            expect.assertions(2);

            const mock = createClient();
            const writeText = vi.fn<(text: string) => Promise<void>>(async () => undefined);

            Object.defineProperty(globalThis.navigator, "clipboard", { configurable: true, value: { writeText } });

            render(renderBrowser(mock));

            await screen.findByTestId("fb-table");

            fireEvent.click(screen.getByTestId("storage-copy-a.png"));

            await waitFor(() => {
                if (writeText.mock.calls.length === 0) {
                    throw new Error("not copied yet");
                }
            });

            expect(mock.signedStorageUrl).toHaveBeenCalledWith("a.png");
            expect(writeText).toHaveBeenCalledWith("https://mock.example/a.png?sig=test");
        });
    });
});
