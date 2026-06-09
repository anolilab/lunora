import type { StorageListPage } from "@cirrus/client";
import { CirrusProvider } from "@cirrus/react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import { describe, expect, it } from "vitest";

import { FileBrowser } from "../src/file-browser";
import type { MockClientHooks } from "./mock-client";
import { createMockClient } from "./mock-client";

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
        listStorageObjects: (options): StorageListPage => (options.cursor === "c1" ? PAGE_TWO : PAGE_ONE),
    });

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
        expect(rows[0]?.textContent).toContain("avatars/a.png");
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

        const error = await screen.findByTestId("fb-error");

        expect(error.textContent).toBe("STORAGE_NOT_CONFIGURED");
    });
});
