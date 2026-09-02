import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { RowDetailDrawer } from "../../../src/features/data/row-detail";

const COLUMNS = ["_id", "_creationTime", "authorId", "title", "meta", "deleted"];
const ROW: Record<string, unknown> = {
    _creationTime: 1_700_000_000_000,
    _id: "p1",
    authorId: "u1",
    deleted: null,
    meta: { tags: ["a", "b"] },
    title: "Hello",
};

const DEFAULT_REFS = { authorId: "users" };

const renderDrawer = (overrides: Partial<Parameters<typeof RowDetailDrawer>[0]> = {}) =>
    render(
        <RowDetailDrawer
            columns={COLUMNS}
            mask={overrides.mask ?? { columns: new Map(), enabled: false }}
            onClose={overrides.onClose ?? vi.fn<() => void>()}
            onNavigate={overrides.onNavigate ?? vi.fn<(target: string, id: string) => void>()}
            refs={overrides.refs ?? DEFAULT_REFS}
            row={overrides.row ?? ROW}
        />,
    );

describe("rowDetailDrawer", () => {
    it("renders every column as a labelled field", () => {
        expect.assertions(2);

        renderDrawer();

        expect(screen.getByTestId("rd-field-title").textContent).toContain("Hello");
        expect(screen.getAllByTestId(/^rd-field-/u)).toHaveLength(COLUMNS.length);
    });

    it("renders a bytes field as its size, not the `{}` an ArrayBuffer pretty-prints to", () => {
        expect.assertions(1);

        // The grid cell shows `<bytes: n>`; the drawer expands that same row, so
        // it may not disagree — and `{}` tells the operator nothing.
        render(
            <RowDetailDrawer
                columns={[...COLUMNS, "blob"]}
                mask={{ columns: new Map(), enabled: false }}
                onClose={vi.fn<() => void>()}
                onNavigate={vi.fn<(target: string, id: string) => void>()}
                refs={DEFAULT_REFS}
                row={{ ...ROW, blob: Uint8Array.from([1, 2, 3, 4]).buffer }}
            />,
        );

        expect(screen.getByTestId("rd-bytes-blob").textContent).toBe("<bytes: 4 B>");
    });

    it("renders a null field with the muted null marker, not an empty cell", () => {
        expect.assertions(1);

        renderDrawer();

        expect(screen.getByTestId("rd-field-deleted").textContent).toContain("null");
    });

    it("renders a numeric timestamp field as a readable date, keeping the raw value in the title", () => {
        expect.assertions(2);

        renderDrawer();

        const ts = screen.getByTestId("rd-ts-_creationTime");

        // Not the raw epoch number in the body…
        expect(ts.textContent).not.toBe("1700000000000");
        // …but the raw value is preserved on hover.
        expect(ts.getAttribute("title")).toBe("1700000000000");
    });

    it("renders a nested object as pretty JSON", () => {
        expect.assertions(1);

        renderDrawer();

        expect(screen.getByTestId("rd-field-meta").textContent).toContain('"tags"');
    });

    it("renders a foreign-key field as a link that navigates and closes", () => {
        expect.assertions(2);

        const onNavigate = vi.fn<(target: string, id: string) => void>();
        const onClose = vi.fn<() => void>();

        renderDrawer({ onClose, onNavigate });

        fireEvent.click(screen.getByTestId("rd-ref-authorId"));

        expect(onNavigate).toHaveBeenCalledWith("users", "u1");
        expect(onClose).toHaveBeenCalledTimes(1);
    });

    it("closes when the close button or overlay is clicked", () => {
        expect.assertions(2);

        const onClose = vi.fn<() => void>();

        renderDrawer({ onClose });

        fireEvent.click(screen.getByTestId("rd-close"));
        fireEvent.click(screen.getByTestId("rd-overlay"));

        expect(onClose).toHaveBeenCalledTimes(2);

        // Clicking inside the panel must NOT close the drawer.
        fireEvent.click(screen.getByTestId("rd-panel"));

        expect(onClose).toHaveBeenCalledTimes(2);
    });
});
