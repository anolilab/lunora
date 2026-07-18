import type { StorageListPage } from "@lunora/client";
import { LunoraProvider } from "@lunora/react";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { FileBrowser } from "../../../src/features/storage/file-browser";
import { ADMIN_FUNCTIONS } from "../../../src/lib/admin";
import type { MockClientHooks } from "../../mock-client";
import { createMockClient } from "../../mock-client";

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
    <LunoraProvider client={mock.asClient}>
        <FileBrowser />
    </LunoraProvider>
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

    it("re-lists at the parent prefix when a breadcrumb is clicked", async () => {
        expect.assertions(2);

        const mock = createMockClient({
            listStorageObjects: (options): StorageListPage => (options.prefix === "docs/" ? DOCS_PAGE : NESTED_PAGE),
        });

        render(renderBrowser(mock));

        await screen.findByTestId("fb-table");

        // Descend into docs/ (the first, alphabetically-sorted folder).
        fireEvent.click(screen.getAllByTestId("fb-folder")[0] as HTMLElement);
        await screen.findByText("guide.md");

        // The breadcrumb bar now shows root + docs; click the root crumb to go back up.
        const crumbs = within(screen.getByTestId("fb-breadcrumbs"));

        fireEvent.click(crumbs.getByRole("button", { name: "root" }));

        await waitFor(() => {
            if ((mock.listStorageObjects.mock.calls.at(-1)?.[0] as { prefix?: string }).prefix !== "") {
                throw new Error("not relisted at root yet");
            }
        });

        const lastCall = mock.listStorageObjects.mock.calls.at(-1) as [{ prefix?: string }];

        expect(lastCall[0]).toMatchObject({ prefix: "" });
        // Back at root we again see the two sub-folders.
        expect(screen.getAllByTestId("fb-folder")).toHaveLength(2);
    });

    it("clears the selection when navigating into a folder", async () => {
        expect.assertions(2);

        const mock = createMockClient({
            listStorageObjects: (options): StorageListPage => (options.prefix === "docs/" ? DOCS_PAGE : NESTED_PAGE),
        });

        render(renderBrowser(mock));

        await screen.findByTestId("fb-table");

        // Select the one root-level file, then descend into a folder.
        fireEvent.click(screen.getByTestId("storage-select-root.txt"));

        expect(screen.getByTestId("grid-selection-count").textContent).toContain("1 selected");

        fireEvent.click(screen.getAllByTestId("fb-folder")[0] as HTMLElement);
        await screen.findByText("guide.md");

        // The selection bar is gone — navigate cleared the selection.
        expect(screen.queryByTestId("grid-selection-bar")).toBeNull();
    });

    it("sorts files by a chosen metadata field", async () => {
        expect.assertions(2);

        render(renderBrowser(createClient()));

        await screen.findByTestId("fb-table");

        // Default name-ascending → a.png before b.txt.
        expect(screen.getAllByTestId("fb-row")[0]?.textContent).toContain("a.png");

        // Sort by size ascending → the smaller b.txt (12 B) comes first.
        fireEvent.change(screen.getByTestId("fb-sort"), { target: { value: "size" } });

        expect(screen.getAllByTestId("fb-row")[0]?.textContent).toContain("b.txt");
    });

    it("switches to the grid view and renders a tile per file", async () => {
        expect.assertions(2);

        render(renderBrowser(createClient()));

        await screen.findByTestId("fb-table");

        fireEvent.click(screen.getByTestId("fb-view-grid"));

        await expect(screen.findByTestId("fb-gallery")).resolves.toBeDefined();
        expect(screen.getAllByTestId("fb-tile")).toHaveLength(2);
    });

    it("bulk-deletes the selected files", async () => {
        expect.assertions(2);

        const mock = createClient();

        render(renderBrowser(mock));

        await screen.findByTestId("fb-table");

        // Select every loaded file via the header checkbox.
        fireEvent.click(screen.getByTestId("storage-select-all"));

        const countBar = await screen.findByTestId("grid-selection-count");

        expect(countBar.textContent).toContain("2 selected");

        // Confirm the bulk delete → one delete per selected key (a.png, b.txt).
        fireEvent.click(screen.getByTestId("grid-selection-delete"));
        fireEvent.click(screen.getByTestId("grid-selection-delete-confirm"));

        await waitFor(() => {
            if (mock.deleteStorageObject.mock.calls.length < 2) {
                throw new Error("not all deleted yet");
            }
        });

        expect(mock.deleteStorageObject).toHaveBeenCalledTimes(2);
    });

    it("joins records to files: a used-by badge for an owned object and an orphan badge for an unreferenced one", async () => {
        expect.assertions(3);

        const REFERENCED_PAGE: StorageListPage = {
            objects: [
                { etag: "r1", key: "owned.png", size: 10 },
                { etag: "r2", key: "orphan.png", size: 20 },
            ],
        };
        const mock = createMockClient({
            listStorageObjects: (): StorageListPage => REFERENCED_PAGE,
            query: (reference): unknown =>
                reference === ADMIN_FUNCTIONS.storageReferences
                    ? {
                          references: { "orphan.png": [], "owned.png": [{ column: "avatar", id: "u1", table: "users" }] },
                          storageColumns: { users: ["avatar"] },
                      }
                    : undefined,
        });

        render(renderBrowser(mock));

        await screen.findByTestId("fb-table");

        // The owned object shows a "1 record" used-by badge titled with its owner.
        const usedBy = await screen.findByTestId("storage-refs-owned.png");

        expect(usedBy.textContent).toContain("1 record");
        expect(usedBy.getAttribute("title")).toContain("users·u1");

        // The unreferenced object is flagged as an orphan.
        expect(screen.getByTestId("storage-orphan-orphan.png").textContent).toContain("Orphan");
    });

    it("detects dangling references: a record field pointing at an object the bucket no longer has", async () => {
        expect.assertions(2);

        const PAGE: StorageListPage = { objects: [{ etag: "k1", key: "live.png", size: 10 }] };
        const mock = createMockClient({
            listStorageObjects: (): StorageListPage => PAGE,
            query: (reference): unknown => {
                if (reference === ADMIN_FUNCTIONS.storageReferences) {
                    return { references: { "live.png": [] }, storageColumns: { users: ["avatar"] } };
                }

                if (reference === ADMIN_FUNCTIONS.storageOrphans) {
                    return { references: [{ column: "avatar", id: "u9", key: "gone.png", table: "users" }], scanned: 1, truncated: false };
                }

                return undefined;
            },
        });

        render(renderBrowser(mock));

        await screen.findByTestId("fb-table");

        // The orphan-check section is shown (the schema declares a v.storage() column).
        fireEvent.click(await screen.findByTestId("fb-orphans-check"));

        const dangling = await screen.findByTestId("fb-dangling-users-u9-avatar");

        expect(dangling.textContent).toContain("users·u9");
        expect(dangling.textContent).toContain("gone.png");
    });

    it("shows the empty state when the orphan check finds no dangling references", async () => {
        expect.assertions(1);

        const PAGE: StorageListPage = { objects: [{ etag: "k1", key: "live.png", size: 10 }] };
        const mock = createMockClient({
            listStorageObjects: (): StorageListPage => PAGE,
            query: (reference): unknown => {
                if (reference === ADMIN_FUNCTIONS.storageReferences) {
                    return { references: { "live.png": [{ column: "avatar", id: "u1", table: "users" }] }, storageColumns: { users: ["avatar"] } };
                }

                if (reference === ADMIN_FUNCTIONS.storageOrphans) {
                    return { references: [], scanned: 1, truncated: false };
                }

                return undefined;
            },
        });

        render(renderBrowser(mock));

        await screen.findByTestId("fb-table");
        fireEvent.click(await screen.findByTestId("fb-orphans-check"));

        await expect(screen.findByTestId("fb-orphans-empty")).resolves.toBeDefined();
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

            expect(mock.deleteStorageObject).toHaveBeenCalledWith("a.png", { bucket: "" });

            // The post-delete re-list re-calls listStorageObjects (mount + refresh).
            await waitFor(() => {
                if (mock.listStorageObjects.mock.calls.length < 2) {
                    throw new Error("not relisted yet");
                }
            });

            expect(mock.listStorageObjects.mock.calls.length).toBeGreaterThanOrEqual(2);
        });

        it("resolves a signed URL and triggers a download", async () => {
            expect.assertions(3);

            const mock = createClient();

            // Stub the transient anchor click so jsdom doesn't try to navigate.
            const click = vi.spyOn(globalThis.HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);

            render(renderBrowser(mock));

            await screen.findByTestId("fb-table");

            const button = screen.getByTestId("storage-download-a.png");

            expect(button).toBeDefined();

            fireEvent.click(button);

            await waitFor(() => {
                if (mock.signedStorageUrl.mock.calls.length === 0) {
                    throw new Error("not resolved yet");
                }
            });

            // The download requests a signed link, then clicks the transient anchor.
            expect(mock.signedStorageUrl).toHaveBeenCalledWith("a.png", { bucket: "", expiresInSeconds: 3600 });
            expect(click).toHaveBeenCalledWith();

            click.mockRestore();
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

            // The copy action requests a link with the toolbar's default 1h lifetime.
            expect(mock.signedStorageUrl).toHaveBeenCalledWith("a.png", { bucket: "", expiresInSeconds: 3600 });
            expect(writeText).toHaveBeenCalledWith("https://mock.example/a.png?sig=test");
        });
    });

    describe("bucket picker", () => {
        it("hides the picker when the worker exposes no buckets", async () => {
            expect.assertions(1);

            render(renderBrowser(createClient()));

            await screen.findByTestId("fb-table");

            expect(screen.queryByTestId("fb-bucket")).toBeNull();
        });

        it("shows the picker and re-lists the selected bucket", async () => {
            expect.hasAssertions();

            const mock = createMockClient({
                listStorageBuckets: () => ["default", "media"],
                listStorageObjects: (): StorageListPage => PAGE_ONE,
            });

            render(renderBrowser(mock));

            const picker = await screen.findByTestId("fb-bucket");

            // First load defaults to the first bucket.
            await waitFor(() => {
                expect(mock.listStorageObjects).toHaveBeenCalledWith(expect.objectContaining({ bucket: "default" }));
            });

            fireEvent.change(picker, { target: { value: "media" } });

            await waitFor(() => {
                expect(mock.listStorageObjects).toHaveBeenCalledWith(expect.objectContaining({ bucket: "media" }));
            });
        });
    });
});
