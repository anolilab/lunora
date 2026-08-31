import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { CascadePreviewDialog } from "../../../src/features/data/cascade-preview";
import type { AdvisorSchema } from "../../../src/lib/cascade-schema";
import { advisorSchemaFromColumns, buildCascadeMap, walkCascade } from "../../../src/lib/cascade-schema";

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

    it("keeps an edge whose onDelete was never declared", () => {
        expect.assertions(2);

        // The studio's own feeder (`describeTables`) reports FK targets but not the
        // declared action. Dropping those edges left the preview showing "no
        // related rows" for a table that has children — the operator's cue that
        // something is downstream disappears exactly when it matters.
        const map = buildCascadeMap({
            tables: [
                { fields: ["title"], indexes: [], name: "posts", relations: [] },
                {
                    fields: ["postId"],
                    indexes: [],
                    name: "comments",
                    relations: [{ field: "postId", kind: "one", name: "postId", references: "posts", table: "comments" }],
                },
            ],
        });

        expect(map.get("posts")?.[0]?.table).toBe("comments");
        expect(map.get("posts")?.[0]?.onDelete).toBeUndefined();
    });

    it("handles a cycle schema without throwing", () => {
        expect.assertions(1);

        // The map build itself is pure — it should not loop.
        expect(() => buildCascadeMap(CYCLE_SCHEMA)).not.toThrow();
    });
});

describe("advisorSchemaFromColumns", () => {
    it("turns v.id ref columns into relations with no declared onDelete", () => {
        expect.assertions(3);

        const schema = advisorSchemaFromColumns({
            comments: [
                { name: "_id", optional: false, pk: true, type: "id" },
                { name: "postId", optional: false, ref: "posts", type: "id" },
                { name: "text", optional: false, type: "string" },
            ],
            posts: [{ name: "title", optional: false, type: "string" }],
        });

        const comments = schema.tables.find((table) => table.name === "comments");

        expect(comments?.relations).toHaveLength(1);
        expect(comments?.relations[0]).toMatchObject({ field: "postId", kind: "one", references: "posts", table: "comments" });
        // Never invented: the admin wire carries no `onDelete`, and claiming a
        // cascade the studio cannot see would be a lie in a destructive dialog.
        expect(comments?.relations[0]?.onDelete).toBeUndefined();
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

/** One `readPage` reply carrying `rowCount` rows (capped at the page size). */
const pageOf = (rowCount: number) => {
    return {
        columns: ["_id"],
        refs: {},
        rows: Array.from({ length: Math.min(rowCount, 100) }, (_, i) => {
            return { __id__: `r${i.toString()}` };
        }),
        total: rowCount,
    };
};

type ReadPage = (_table: string, _column: string, _value: string) => Promise<ReturnType<typeof pageOf>>;

const makeReadPage = (rowCount: number = 0) => vi.fn<ReadPage>(async (_table: string, _column: string, _value: string) => pageOf(rowCount));

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

// ── Regression: the impact count is scoped to the foreign-key column ─────────

/** users ← posts, via TWO distinct FK columns (author and editor). */
const TWO_FK_SCHEMA: AdvisorSchema = {
    tables: [
        { fields: ["email"], indexes: [], name: "users", relations: [] },
        {
            fields: ["authorId", "editorId", "title"],
            indexes: [],
            name: "posts",
            relations: [
                { field: "authorId", kind: "one", name: "author", onDelete: "cascade", references: "users", table: "users" },
                { field: "editorId", kind: "one", name: "editor", onDelete: "cascade", references: "users", table: "users" },
            ],
        },
    ],
};

describe("cascade impact counting", () => {
    it("counts by the FK column, not by a free-text search over every column", async () => {
        expect.assertions(2);

        // The shard only ever matches rows whose `postId` IS the parent id — the
        // behaviour a column-equality filter has. A free-text `search` read would
        // additionally match a row that merely quotes the id in its body, so the
        // old call shape both mis-addresses this mock and overstates the count.
        const readPage = vi.fn<ReadPage>(async (_table: string, column: string, value: string) =>
            column === "postId" && value === "row1" ? pageOf(2) : pageOf(0),
        );

        renderDialog({ readPage, rowId: "row1", schema: CASCADE_SCHEMA, table: "posts" });

        await waitForLoaded();

        expect(readPage).toHaveBeenCalledWith("comments", "postId", "row1");
        expect(screen.getByTestId("cascade-row-comments").textContent).toContain("2 rows");
    });

    it("counts each FK column of the same child table separately", async () => {
        expect.assertions(4);

        // Two FKs from posts to users. Scoped per column they are two different
        // questions with two different answers; the unscoped search gave both the
        // same number and rendered two indistinguishable rows.
        const readPage = vi.fn<ReadPage>(async (_table: string, column: string) => (column === "authorId" ? pageOf(3) : pageOf(0)));

        renderDialog({ readPage, rowId: "u1", schema: TWO_FK_SCHEMA, table: "users" });

        await waitForLoaded();

        const rows = screen.getAllByTestId("cascade-row-posts");

        // One node per (table, column) — not two identical ones.
        expect(rows).toHaveLength(2);
        expect(screen.getByTestId("cascade-col-posts-authorId").textContent).toContain("authorId");
        expect(rows[0]?.textContent).toContain("3 rows");
        expect(rows[1]?.textContent).toContain("0 rows");
    });

    it("collapses the same (child table, column) edge declared twice into one", () => {
        expect.assertions(1);

        // A duplicated edge is still one edge; keeping both doubled the rendered
        // blast radius of the delete.
        const map = buildCascadeMap({
            tables: [
                { fields: ["title"], indexes: [], name: "posts", relations: [] },
                {
                    fields: ["postId"],
                    indexes: [],
                    name: "comments",
                    relations: [
                        { field: "postId", kind: "one", name: "post", onDelete: "cascade", references: "posts", table: "posts" },
                        { field: "postId", kind: "one", name: "post", onDelete: "cascade", references: "posts", table: "posts" },
                    ],
                },
            ],
        });

        expect(map.get("posts")).toHaveLength(1);
    });
});
