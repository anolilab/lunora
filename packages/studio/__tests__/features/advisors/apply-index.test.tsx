import { LunoraProvider } from "@lunora/react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ApplyIndexButton } from "../../../src/features/advisors/apply-index-button";
import { composeCreateIndex, hasIndexMetadata } from "../../../src/features/advisors/compose-index-sql";
import { InsightsPanel } from "../../../src/features/advisors/insights-panel";
import type { AdvisoryFinding, FunctionStatsResult, ShardMetrics } from "../../../src/lib/admin";
import { ADMIN_FUNCTIONS } from "../../../src/lib/admin";
import type { MockClientHooks } from "../../mock-client";
import { createMockClient } from "../../mock-client";
import wrapInRouter from "../../render-with-router";

// ── unit tests: composeCreateIndex ──────────────────────────────────────────

describe("composeCreateIndex", () => {
    it("composes a CREATE INDEX IF NOT EXISTS statement with quoted identifiers", () => {
        expect.assertions(1);

        expect(composeCreateIndex("posts", "byAuthorId", ["authorId"])).toBe(`CREATE INDEX IF NOT EXISTS "byAuthorId" ON "posts" ("authorId");`);
    });

    it("handles a composite index (multiple columns)", () => {
        expect.assertions(1);

        expect(composeCreateIndex("posts", "byAuthorCreated", ["authorId", "createdAt"])).toBe(
            `CREATE INDEX IF NOT EXISTS "byAuthorCreated" ON "posts" ("authorId", "createdAt");`,
        );
    });

    it("uses IF NOT EXISTS so the statement is idempotent", () => {
        expect.assertions(1);

        expect(composeCreateIndex("users", "byEmail", ["email"])).toContain("IF NOT EXISTS");
    });

    it("escapes a double quote embedded in the table name by doubling it", () => {
        expect.assertions(1);

        expect(composeCreateIndex('po"sts', "byAuthorId", ["authorId"])).toBe(`CREATE INDEX IF NOT EXISTS "byAuthorId" ON "po""sts" ("authorId");`);
    });

    it("escapes a double quote embedded in a column name by doubling it", () => {
        expect.assertions(1);

        expect(composeCreateIndex("posts", "byWeird", ['we"ird'])).toBe(`CREATE INDEX IF NOT EXISTS "byWeird" ON "posts" ("we""ird");`);
    });
});

// ── unit tests: hasIndexMetadata ────────────────────────────────────────────

describe("hasIndexMetadata", () => {
    it("returns true when table and suggestedIndex fields are present", () => {
        expect.assertions(1);

        expect(
            hasIndexMetadata({
                suggestedIndex: { fields: ["authorId"], name: "byAuthorId" },
                table: "posts",
            }),
        ).toBe(true);
    });

    it("returns false when table is missing", () => {
        expect.assertions(1);

        expect(
            hasIndexMetadata({
                suggestedIndex: { fields: ["authorId"], name: "byAuthorId" },
            }),
        ).toBe(false);
    });

    it("returns false when suggestedIndex.fields is empty", () => {
        expect.assertions(1);

        expect(
            hasIndexMetadata({
                suggestedIndex: { fields: [], name: "byAuthorId" },
                table: "posts",
            }),
        ).toBe(false);
    });

    it("returns false when suggestedIndex is absent", () => {
        expect.assertions(1);

        expect(hasIndexMetadata({ table: "posts" })).toBe(false);
    });

    it("returns false when a field is not a usable string", () => {
        expect.assertions(2);

        // A non-empty `fields` passed the length check with unusable ELEMENTS in
        // it, so `[null]` reached `quoteIdentifier` and threw inside the render.
        expect(hasIndexMetadata({ suggestedIndex: { fields: [null], name: "byAuthorId" }, table: "posts" })).toBe(false);
        expect(hasIndexMetadata({ suggestedIndex: { fields: ["authorId", 42], name: "byAuthorId" }, table: "posts" })).toBe(false);
    });

    it("returns false when suggestedIndex.name is not a usable string", () => {
        expect.assertions(2);

        // `metadata` is server-supplied `Record<string, unknown>`. The narrowing
        // asserted `suggestedIndex.name: string` without ever checking it, so a
        // finding carrying a non-string name reached `quoteIdentifier`, which
        // calls `.replaceAll` on it — a TypeError inside the render.
        expect(hasIndexMetadata({ suggestedIndex: { fields: ["authorId"], name: 7 }, table: "posts" })).toBe(false);
        expect(hasIndexMetadata({ suggestedIndex: { fields: ["authorId"], name: "" }, table: "posts" })).toBe(false);
    });

    it("returns false when a FIELD is not a usable string", () => {
        expect.assertions(3);

        // Same defect one level down: `Array.isArray` accepted `[null]` / `[42]`
        // and the predicate then exposed them as strings, so the action handed
        // one to `sqlIdentifier` and `.replaceAll` threw during the render.
        expect(hasIndexMetadata({ suggestedIndex: { fields: [null], name: "byAuthorId" }, table: "posts" })).toBe(false);
        expect(hasIndexMetadata({ suggestedIndex: { fields: [42], name: "byAuthorId" }, table: "posts" })).toBe(false);
        expect(hasIndexMetadata({ suggestedIndex: { fields: ["authorId", ""], name: "byAuthorId" }, table: "posts" })).toBe(false);
    });
});

// ── render test: ApplyIndexButton ───────────────────────────────────────────

const renderButton = (overrides: Partial<{ fields: ReadonlyArray<string>; indexName: string; table: string; testId: string }> = {}) => {
    const props = {
        fields: ["authorId"] as ReadonlyArray<string>,
        indexName: "byAuthorId",
        table: "posts",
        testId: "test-apply",
        ...overrides,
    };

    // ApplyIndexButton uses useT — wrap in a LunoraProvider that supplies i18n.
    const mock = createMockClient();

    return render(
        <LunoraProvider client={mock.asClient}>
            <ApplyIndexButton fields={props.fields} indexName={props.indexName} table={props.table} testId={props.testId} />
        </LunoraProvider>,
    );
};

describe("applyIndexButton", () => {
    it("renders the apply label with the table name", () => {
        expect.assertions(1);

        renderButton({ table: "posts" });

        expect(screen.getByTestId("test-apply").textContent).toContain("posts");
    });

    it("shows confirm/cancel after the first click", () => {
        expect.assertions(2);

        renderButton();
        fireEvent.click(screen.getByTestId("test-apply"));

        expect(screen.getByTestId("test-apply-confirm")).toBeDefined();
        expect(screen.getByTestId("test-apply-cancel")).toBeDefined();
    });

    it("copies SQL to clipboard and shows the copied state after confirm", async () => {
        expect.assertions(1);

        const writeText = vi.fn<(_sql: string) => Promise<void>>(() => Promise.resolve());
        Object.defineProperty(globalThis.navigator, "clipboard", {
            configurable: true,
            value: { writeText },
        });

        renderButton({ fields: ["authorId"], indexName: "byAuthorId", table: "posts" });
        fireEvent.click(screen.getByTestId("test-apply"));
        fireEvent.click(screen.getByTestId("test-apply-confirm"));

        // Awaited, not synchronous: this used to call `setApplied(true)` on the
        // line after an un-awaited `writeText`, so a REJECTED copy still rendered
        // "copied to clipboard".
        await screen.findByTestId("test-apply-applied");

        expect(writeText).toHaveBeenCalledWith(`CREATE INDEX IF NOT EXISTS "byAuthorId" ON "posts" ("authorId");`);
    });

    it("does not claim a copy when the clipboard write rejects", async () => {
        expect.assertions(2);

        const writeText = vi.fn<(_sql: string) => Promise<void>>(() => Promise.reject(new Error("denied")));
        Object.defineProperty(globalThis.navigator, "clipboard", {
            configurable: true,
            value: { writeText },
        });

        renderButton({ fields: ["authorId"], indexName: "byAuthorId", table: "posts" });
        fireEvent.click(screen.getByTestId("test-apply"));
        fireEvent.click(screen.getByTestId("test-apply-confirm"));

        // The statement is shown for manual copying instead — a state-changing
        // `fireAndForget` with no `onError` (see `lib/internal.ts`) just swallowed
        // the rejection.
        const fallback = await screen.findByTestId("test-apply-manual");

        expect(fallback.textContent).toContain(`CREATE INDEX IF NOT EXISTS "byAuthorId" ON "posts" ("authorId");`);
        expect(screen.queryByTestId("test-apply-applied")).toBeNull();
    });

    it("shows the statement when there is no clipboard at all (non-secure context)", async () => {
        expect.assertions(2);

        // The studio served over a LAN IP is not a secure context, so
        // `navigator.clipboard` is undefined. Confirming used to return with no
        // state change and no message whatsoever — the button simply did nothing.
        Object.defineProperty(globalThis.navigator, "clipboard", { configurable: true, value: undefined });

        renderButton({ fields: ["authorId"], indexName: "byAuthorId", table: "posts" });
        fireEvent.click(screen.getByTestId("test-apply"));
        fireEvent.click(screen.getByTestId("test-apply-confirm"));

        const fallback = await screen.findByTestId("test-apply-manual");

        expect(fallback.textContent).toContain(`CREATE INDEX IF NOT EXISTS "byAuthorId" ON "posts" ("authorId");`);
        expect(screen.queryByTestId("test-apply-applied")).toBeNull();
    });

    it("returns to the button after cancel", () => {
        expect.assertions(2);

        renderButton();
        fireEvent.click(screen.getByTestId("test-apply"));
        fireEvent.click(screen.getByTestId("test-apply-cancel"));

        // Cancel returns to the initial trigger.
        expect(screen.getByTestId("test-apply")).toBeDefined();
        expect(screen.queryByTestId("test-apply-confirm")).toBeNull();
    });
});

// ── render test: InsightsPanel wires the apply action on FK findings ─────────

const HEALTHY: ShardMetrics = {
    cache: { bytes: 0, entries: 4, evictions: 0, hits: 90, misses: 10 },
    databaseSize: 1024,
    errors: 0,
    requests: 100,
    shard: "__root__",
    sinceMs: 1_700_000_000_000,
    uptimeMs: 1000,
};
const EMPTY_STATS: FunctionStatsResult = { functions: [], sinceMs: 1_700_000_000_000 };

const FK_ADVISORY: AdvisoryFinding = {
    cacheKey: "unindexed_foreign_key:posts:authorId",
    categories: ["PERFORMANCE"],
    description: "A foreign-key column has no index.",
    detail: 'Relation "author" on table "posts" references "users" via column "authorId".',
    facing: "EXTERNAL",
    level: "INFO",
    metadata: {
        fkColumn: "authorId",
        references: { column: "_id", table: "users" },
        relation: "author",
        suggestedIndex: { fields: ["authorId"], name: "byAuthorId" },
        table: "posts",
    },
    name: "unindexed_foreign_key",
    remediation: 'Add `.index("byAuthorId", ["authorId"])`.',
    title: "Unindexed foreign key",
};

const createClient = (advisories: AdvisoryFinding[] = []): MockClientHooks =>
    createMockClient({
        query: (reference): unknown => {
            if (reference === ADMIN_FUNCTIONS.getMetrics) {
                return HEALTHY;
            }

            if (reference === ADMIN_FUNCTIONS.getFunctionStats) {
                return EMPTY_STATS;
            }

            if (reference === ADMIN_FUNCTIONS.getAdvisories) {
                return { advisories };
            }

            throw new Error(`unexpected ${reference}`);
        },
    });

describe("insights panel — apply-index action on FK findings", () => {
    it("renders an Apply index button for an unindexed_foreign_key advisory", async () => {
        expect.assertions(1);

        const mock = createClient([FK_ADVISORY]);

        render(
            wrapInRouter(
                <LunoraProvider client={mock.asClient}>
                    <InsightsPanel />
                </LunoraProvider>,
            ),
        );

        // unindexed_foreign_key is INFO-severity → switch to the Info tab.
        fireEvent.click(await screen.findByTestId("lunora-insights-tab-info"));
        await screen.findByText("Unindexed foreign key");

        // The apply-index button should be visible on the row.
        const applyBtn = await screen.findByTestId("in-apply-index-posts-byAuthorId");

        expect(applyBtn.textContent).toContain("posts");
    });

    it("does NOT render an Apply button for advisories without suggestedIndex metadata", async () => {
        expect.assertions(1);

        // A finding that has no suggestedIndex — should not get an apply button.
        const advisory: AdvisoryFinding = {
            ...FK_ADVISORY,
            cacheKey: "other_advisory",
            metadata: { table: "posts" }, // no suggestedIndex
            name: "other_advisory",
            title: "Other advisory",
        };
        const mock = createClient([advisory]);

        render(
            wrapInRouter(
                <LunoraProvider client={mock.asClient}>
                    <InsightsPanel />
                </LunoraProvider>,
            ),
        );

        fireEvent.click(await screen.findByTestId("lunora-insights-tab-info"));
        await screen.findByText("Other advisory");

        // No apply button present (different name, no suggestedIndex).
        expect(screen.queryByTestId(/in-apply-index/)).toBeNull();
    });
});
