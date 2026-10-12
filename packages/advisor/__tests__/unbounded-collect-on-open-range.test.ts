import { defineSchema, defineTable } from "@lunora/server";
import { v } from "@lunora/values";
import { describe, expect, it } from "vitest";

import type { AdvisorCallEdge, AdvisorQueryRead, AdvisorRowEffect, AdvisorTableWrite, LintContext } from "../src";
import { fromServerSchema } from "../src";
import unboundedCollectOnOpenRange from "../src/lints/static/unbounded-collect-on-open-range";

const schema = fromServerSchema(defineSchema({ sessions: defineTable({ expiresAt: v.number() }).index("by_expiry", ["expiresAt"]) }));

/** An open `withIndex` collect in export `expire` of file `sweep`, internal by default. */
const read = (overrides: Partial<AdvisorQueryRead> = {}): AdvisorQueryRead => {
    return {
        file: "sweep",
        hasFilter: false,
        hasIndex: true,
        index: { bounds: ["gt"], name: "by_expiry" },
        line: 7,
        scope: { kind: "export", name: "expire" },
        table: "sessions",
        terminal: "collect",
        visibility: "internal",
        ...overrides,
    };
};

const context = (overrides: Partial<LintContext> = {}): LintContext => {
    return { schema, ...overrides };
};

/** A scheduler edge that drives `sweep:expire` from another file. */
const scheduled: AdvisorCallEdge = { file: "kick", kind: "schedule", line: 3, scope: { kind: "export", name: "start" }, target: "sweep:expire" };

describe("unbounded_collect_on_open_range", () => {
    it("flags an open-range collect in an internal function", () => {
        expect.assertions(2);

        const findings = unboundedCollectOnOpenRange.run(context({ queries: [read()] }));

        expect(findings).toStrictEqual([
            expect.objectContaining({ cacheKey: "unbounded_collect_on_open_range:sweep:7:sessions", level: "WARN", name: "unbounded_collect_on_open_range" }),
        ]);
        expect(findings[0]?.detail).toContain('index "by_expiry"');
    });

    it("flags a public-visibility read that a scheduled dispatch runs", () => {
        expect.assertions(1);

        expect(unboundedCollectOnOpenRange.run(context({ callEdges: [scheduled], queries: [read({ visibility: "public" })] }))).toHaveLength(1);
    });

    it("flags a public read that a cron job fires", () => {
        expect.assertions(1);

        expect(unboundedCollectOnOpenRange.run(context({ cronTargets: ["sweep:expire"], queries: [read({ visibility: "public" })] }))).toHaveLength(1);
    });

    it("flags a bare withIndex with no range callback, which is the widest open range", () => {
        expect.assertions(1);

        expect(unboundedCollectOnOpenRange.run(context({ queries: [read({ index: { bounds: [], name: "by_expiry" } })] }))).toHaveLength(1);
    });

    it("says nothing about a public function that nothing schedules", () => {
        expect.assertions(1);

        expect(unboundedCollectOnOpenRange.run(context({ queries: [read({ visibility: "public" })] }))).toHaveLength(0);
    });

    it("treats an eq-only range as a lookup: silent when internal, flagged only when the server schedules it", () => {
        expect.assertions(2);

        // One value's rows is a lookup, not a sweep, so an internal function alone does not make it one.
        expect(unboundedCollectOnOpenRange.run(context({ queries: [read({ index: { bounds: ["eq"], name: "by_expiry" } })] }))).toHaveLength(0);
        expect(
            unboundedCollectOnOpenRange.run(context({ callEdges: [scheduled], queries: [read({ index: { bounds: ["eq"], name: "by_expiry" } })] })),
        ).toHaveLength(1);
    });

    it("says nothing when the range has an upper bound", () => {
        expect.assertions(1);

        expect(unboundedCollectOnOpenRange.run(context({ queries: [read({ index: { bounds: ["gt", "lt"], name: "by_expiry" } })] }))).toHaveLength(0);
    });

    it("says nothing when the chain caps or pages the read", () => {
        expect.assertions(2);

        expect(unboundedCollectOnOpenRange.run(context({ queries: [read({ terminal: "take" })] }))).toHaveLength(0);
        expect(unboundedCollectOnOpenRange.run(context({ queries: [read({ terminal: "paginate" })] }))).toHaveLength(0);
    });

    it("holds its verdict when the same function removes rows from the table", () => {
        expect.assertions(2);

        const removing: AdvisorTableWrite = { file: "sweep", line: 9, method: "delete", scope: { kind: "export", name: "expire" }, table: "sessions" };
        const inserting: AdvisorTableWrite = { ...removing, method: "insert" };

        expect(unboundedCollectOnOpenRange.run(context({ queries: [read()], tableWrites: [removing] }))).toHaveLength(0);
        // An audit insert adds rows and removes none, so it does not end the sweep.
        expect(unboundedCollectOnOpenRange.run(context({ queries: [read()], tableWrites: [inserting] }))).toHaveLength(1);
    });

    it("stays silent without the evidence it needs", () => {
        expect.assertions(3);

        expect(unboundedCollectOnOpenRange.run(context({ queries: [read({ index: { name: "by_expiry" } })] }))).toHaveLength(0);
        expect(unboundedCollectOnOpenRange.run(context({ queries: [read({ index: undefined })] }))).toHaveLength(0);
        expect(unboundedCollectOnOpenRange.run(context())).toHaveLength(0);
    });

    it("holds its verdict when a helper in another file deletes the rows the function reads", () => {
        expect.assertions(1);

        // The export calls a helper in `lib/purge.ts` that deletes; the feeder reports that as an effect of the export.
        const effect: AdvisorRowEffect = { exportName: "expire", file: "sweep", method: "delete", table: "sessions" };

        expect(unboundedCollectOnOpenRange.run(context({ queries: [read()], rowEffects: [effect] }))).toHaveLength(0);
    });

    it("counts a patch as progress only when it writes an index field of the range", () => {
        expect.assertions(3);

        const patch = (fields: string[] | undefined): AdvisorTableWrite => {
            return {
                fields,
                file: "sweep",
                line: 9,
                method: "patch",
                scope: { kind: "export", name: "expire" },
                table: "sessions",
            };
        };

        // `expiresAt` is the range's index field: setting it moves the row out of the range.
        expect(unboundedCollectOnOpenRange.run(context({ queries: [read()], tableWrites: [patch(["expiresAt"])] }))).toHaveLength(0);
        // Setting an unrelated field leaves the row in range, so the sweep still re-reads it.
        expect(unboundedCollectOnOpenRange.run(context({ queries: [read()], tableWrites: [patch(["title"])] }))).toHaveLength(1);
        // Fields the feeder could not read are treated as a possible move.
        expect(unboundedCollectOnOpenRange.run(context({ queries: [read()], tableWrites: [patch(undefined)] }))).toHaveLength(0);
    });

    it("names the filtered fields the index does not cover in the one finding for the read", () => {
        expect.assertions(2);

        const findings = unboundedCollectOnOpenRange.run(context({ queries: [read({ filterFields: ["expiresAt", "ownerId"], hasFilter: true })] }));

        expect(findings).toHaveLength(1);
        expect(findings[0]?.detail).toContain('"ownerId", which the index does not cover');
    });

    it("judges progress per caller: a write by another caller of a shared read does not hide a scheduled caller", () => {
        expect.assertions(2);

        // A helper reads the open range for `expire` and `archive`. `expire` deletes; `archive` is only scheduled and deletes nothing.
        const shared = read({ scope: { callers: ["expire", "archive"], kind: "helper", name: "scan" }, visibility: "public" });
        const deletesInExpire: AdvisorTableWrite = { file: "sweep", line: 9, method: "delete", scope: { kind: "export", name: "expire" }, table: "sessions" };
        const schedulesArchive: AdvisorCallEdge = {
            file: "kick",
            kind: "schedule",
            line: 3,
            scope: { kind: "export", name: "start" },
            target: "sweep:archive",
        };

        expect(unboundedCollectOnOpenRange.run(context({ callEdges: [schedulesArchive], queries: [shared], tableWrites: [deletesInExpire] }))).toHaveLength(1);
        // With nothing scheduling `archive`, the read is only server-driven through `expire`, which does delete.
        expect(unboundedCollectOnOpenRange.run(context({ queries: [shared], tableWrites: [deletesInExpire] }))).toHaveLength(0);
    });
});
