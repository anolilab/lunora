import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { CascadePreviewDialog } from "../../../src/features/data/cascade-preview";
import type { AdvisorSchema } from "../../../src/lib/cascade-schema";
import { buildCascadeMap, walkCascade } from "../../../src/lib/cascade-schema";

// ── Fixture schemas ──────────────────────────────────────────────────────────

/** Simple cascade chain: posts → comments (cascade) → replies (cascade). */
const CASCADE_SCHEMA: AdvisorSchema = {
    tables: [
        {
            fields: ["title", "authorId"],
            indexes: [],
            name: "posts",
            relations: [],
        },
        {
            fields: ["postId", "text"],
            indexes: [],
            name: "comments",
            relations: [
                {
                    field: "postId",
                    kind: "one",
                    name: "post",
                    onDelete: "cascade",
                    references: "posts",
                    table: "posts",
                },
            ],
        },
        {
            fields: ["commentId", "text"],
            indexes: [],
            name: "replies",
            relations: [
                {
                    field: "commentId",
                    kind: "one",
                    name: "comment",
                    onDelete: "cascade",
                    references: "comments",
                    table: "comments",
                },
            ],
        },
    ],
};

/** Schema with a restrict relation: orders → lineItems (restrict). */
const RESTRICT_SCHEMA: AdvisorSchema = {
    tables: [
        {
            fields: ["amount"],
            indexes: [],
            name: "orders",
            relations: [],
        },
        {
            fields: ["orderId", "product"],
            indexes: [],
            name: "lineItems",
            relations: [
                {
                    field: "orderId",
                    kind: "one",
                    name: "order",
                    onDelete: "restrict",
                    references: "orders",
                    table: "orders",
                },
            ],
        },
    ],
};

/** Schema with a set-null relation: users → posts (set null). */
const SET_NULL_SCHEMA: AdvisorSchema = {
    tables: [
        { fields: ["email"], indexes: [], name: "users", relations: [] },
        {
            fields: ["authorId", "title"],
            indexes: [],
            name: "posts",
            relations: [
                {
                    field: "authorId",
                    kind: "one",
                    name: "author",
                    onDelete: "set null",
                    references: "users",
                    table: "users",
                },
            ],
        },
    ],
};

/** Schema with a FK cycle: a → b → a (via one-relations in a loop). */
const CYCLE_SCHEMA: AdvisorSchema = {
    tables: [
        {
            fields: ["bId"],
            indexes: [],
            name: "a",
            relations: [
                {
                    field: "bId",
                    kind: "one",
                    name: "b",
                    onDelete: "cascade",
                    references: "b",
                    table: "b",
                },
            ],
        },
        {
            fields: ["aId"],
            indexes: [],
            name: "b",
            relations: [
                {
                    field: "aId",
                    kind: "one",
                    name: "a",
                    onDelete: "cascade",
                    references: "a",
                    table: "a",
                },
            ],
        },
    ],
};

// ── Unit tests for buildCascadeMap ───────────────────────────────────────────

describe("buildCascadeMap", () => {
    it("maps a cascade parent → child relation correctly", () => {
        expect.assertions(2);

        const map = buildCascadeMap(CASCADE_SCHEMA);

        // posts is referenced by comments
        expect(map.has("posts")).toBe(true);
        expect(map.get("posts")?.[0]?.onDelete).toBe("cascade");
    });

    it("excludes set-null relations from the cascade map", () => {
        expect.assertions(1);

        const map = buildCascadeMap(SET_NULL_SCHEMA);

        // users is referenced only via set-null, so it must not appear in the map
        expect(map.has("users")).toBe(false);
    });

    it("includes restrict relations in the cascade map", () => {
        expect.assertions(2);

        const map = buildCascadeMap(RESTRICT_SCHEMA);

        expect(map.has("orders")).toBe(true);
        expect(map.get("orders")?.[0]?.onDelete).toBe("restrict");
    });

    it("builds a multi-level chain (cascade on both levels)", () => {
        expect.assertions(2);

        const map = buildCascadeMap(CASCADE_SCHEMA);

        // comments is referenced by replies
        expect(map.has("comments")).toBe(true);
        expect(map.get("comments")?.[0]?.table).toBe("replies");
    });

    it("handles a cycle schema without throwing", () => {
        expect.assertions(1);

        // The map build itself is pure — it should not loop.
        expect(() => buildCascadeMap(CYCLE_SCHEMA)).not.toThrow();
    });
});

// ── Unit tests for walkCascade ───────────────────────────────────────────────

describe("walkCascade", () => {
    it("collects all nodes matching a predicate via BFS", () => {
        expect.assertions(1);

        const root = {
            children: [
                {
                    children: [{ children: [], isRestrict: true, label: "c" }],
                    isRestrict: false,
                    label: "b",
                },
            ],
            isRestrict: false,
            label: "a",
        };

        const restrictors = walkCascade(root, (n) => n.isRestrict);

        expect(restrictors).toHaveLength(1);
    });

    it("returns an empty array when no nodes match", () => {
        expect.assertions(1);

        const root = { children: [{ children: [], flag: false }], flag: false };
        const found = walkCascade(root, (n) => n.flag);

        expect(found).toHaveLength(0);
    });
});

// ── Render tests for CascadePreviewDialog ────────────────────────────────────

const makeReadPage = (rowCount: number = 0) =>
    vi.fn<(_table: string, _search: string) => Promise<{ columns: string[]; refs: Record<string, string>; rows: Record<string, string>[]; total: number }>>(
        async (_table: string, _search: string) => {
            return {
                columns: ["_id"],
                refs: {},
                rows: Array.from({ length: Math.min(rowCount, 100) }, (_, i) => {
                    return { __id__: `r${i.toString()}` };
                }),
                total: rowCount,
            };
        },
    );

/** Wait until the cascade loading spinner disappears (up to 3s). */
const waitForLoaded = async (): Promise<void> => {
    await waitFor(() => {
        if (screen.queryByTestId("cascade-loading") !== null) {
            throw new Error("still loading");
        }
    });
};

const renderDialog = ({
    onClose = vi.fn<() => void>(),
    onConfirm = vi.fn<() => void>(),
    readPage = makeReadPage(0),
    rowId = "row1",
    schema = CASCADE_SCHEMA,
    table = "posts",
} = {}) => render(<CascadePreviewDialog onClose={onClose} onConfirm={onConfirm} readPage={readPage} rowId={rowId} schema={schema} table={table} />);

describe("cascadePreviewDialog", () => {
    it("renders the dialog title and description after loading", async () => {
        expect.assertions(2);

        renderDialog();

        await waitForLoaded();

        expect(screen.getByTestId("cascade-title").textContent).toContain("Cascade impact");
        // getByTestId throws if not found, so reaching this assertion means the element exists.
        expect(screen.getByTestId("cascade-desc").tagName.toLowerCase()).toBe("p");
    });

    it("shows no loading spinner after resolving", async () => {
        expect.assertions(1);

        renderDialog({ readPage: makeReadPage(3) });

        await waitForLoaded();

        expect(screen.queryByTestId("cascade-loading")).toBeNull();
    });

    it("renders the root table node in the tree", async () => {
        expect.assertions(1);

        renderDialog({ readPage: makeReadPage(0), table: "posts" });

        await waitForLoaded();

        // The root table (posts) always renders in the tree.
        expect(screen.getByTestId("cascade-row-posts").tagName.toLowerCase()).toBe("li");
    });

    it("flags restrict nodes with a restrict badge when rows exist", async () => {
        expect.hasAssertions();

        renderDialog({ readPage: makeReadPage(2), schema: RESTRICT_SCHEMA, table: "orders" });

        await waitForLoaded();

        // A restrict relation should show either the restrict badge or blocker warning.
        await waitFor(() => {
            const element = screen.queryByTestId("cascade-restrict-lineItems") ?? screen.queryByTestId("cascade-blocker-warning");

            expect(element).not.toBeNull();
        });
    });

    it("calls onClose when cancel is clicked", async () => {
        expect.assertions(1);

        const onClose = vi.fn<() => void>();

        renderDialog({ onClose });

        await waitForLoaded();

        fireEvent.click(screen.getByTestId("cascade-cancel"));

        expect(onClose).toHaveBeenCalledTimes(1);
    });

    it("calls onConfirm and onClose when delete is confirmed", async () => {
        expect.assertions(2);

        const onClose = vi.fn<() => void>();
        const onConfirm = vi.fn<() => void>();

        renderDialog({ onClose, onConfirm, readPage: makeReadPage(0) });

        await waitForLoaded();

        fireEvent.click(screen.getByTestId("cascade-confirm"));

        expect(onConfirm).toHaveBeenCalledTimes(1);
        expect(onClose).toHaveBeenCalledTimes(1);
    });

    it("terminates without infinite loop for a cycle schema", async () => {
        expect.assertions(1);

        // The cycle schema has a→b→a. The walk must terminate (not hang/stack overflow).
        // We use a readPage that returns 0 rows so the cycle short-circuits at row lookup.
        renderDialog({ readPage: makeReadPage(0), schema: CYCLE_SCHEMA, table: "a" });

        await waitForLoaded();

        // If we reached here the walk terminated; confirm the dialog panel rendered.
        expect(screen.getByTestId("cascade-panel").tagName.toLowerCase()).toBe("div");
    });
});
