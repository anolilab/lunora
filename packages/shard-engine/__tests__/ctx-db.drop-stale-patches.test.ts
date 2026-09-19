import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { DatabaseWriterLike, SchemaLike } from "../src/ctx-db";
import { createShardCtxDb as createShardContextDatabase, readCdcCursor, runShardMigrations } from "../src/ctx-db";
import createSqliteExec from "./_helpers/node-sqlite";

/**
 * `.dropStalePatches()` — a patch whose fields moved since the caller's CDC
 * baseline is dropped whole rather than clobbering the newer value.
 *
 * Driven through a real SQLite engine and the real changelog, because the whole
 * mechanism IS the changelog: the baseline is a `__cdc_log` post-image, and a
 * test that faked the log would be asserting against its own idea of one.
 */

/** `documents` opts in; `notes` is the identical table that does not, as the control. */
const schema: SchemaLike = {
    tables: {
        documents: {
            dropStalePatchesMode: true,
            indexes: [],
            shape: { body: { kind: "string" }, title: { kind: "string" }, views: { kind: "number" } },
        },
        notes: {
            indexes: [],
            shape: { body: { kind: "string" }, title: { kind: "string" }, views: { kind: "number" } },
        },
    },
};

let harness: ReturnType<typeof createSqliteExec>;

interface Harness {
    /** The cursor a caller reading right now would hold. */
    cursor: () => number;
    dropped: { fields: string[]; id: string; table: string }[];
    /** The caller's baseline, mutable so a test can compose a write "in the past". */
    setBaseline: (seq: number | undefined) => void;
    writer: DatabaseWriterLike;
}

const setup = (): Harness => {
    runShardMigrations(harness.sql, schema, { cdc: true });

    let baseline: number | undefined;
    const dropped: Harness["dropped"] = [];

    const writer = createShardContextDatabase({
        baselineSeq: () => baseline,
        broadcast: () => undefined,
        cdc: true,
        clock: () => 1_700_000_000_000,
        onStalePatchDropped: (event) => dropped.push(event),
        schema,
        sql: harness.sql,
    });

    return {
        cursor: () => readCdcCursor(harness.sql),
        dropped,
        setBaseline: (seq) => {
            baseline = seq;
        },
        writer,
    };
};

describe("ctx-db .dropStalePatches()", () => {
    beforeEach(() => {
        harness = createSqliteExec();
    });

    afterEach(() => {
        harness.close();
    });

    it("drops a patch whose field moved after the caller's baseline", async () => {
        expect.assertions(3);

        const { cursor, dropped, setBaseline, writer } = setup();
        const id = await writer.insert("documents", { body: "b", title: "original", views: 0 });

        // The caller read the row here.
        const baseline = cursor();

        // Someone else edits the same field in between.
        await writer.patch(id, { title: "theirs" });

        // The caller's write lands late, still carrying its own baseline.
        setBaseline(baseline);
        await writer.patch(id, { title: "mine" });

        const titleRow = await writer.get(id);

        expect(titleRow?.["title"]).toBe("theirs");
        expect(dropped).toHaveLength(1);
        expect(dropped[0]).toEqual({ fields: ["title"], id, table: "documents" });
    });

    it("applies a patch to a field nobody else touched — the point of the feature", async () => {
        expect.assertions(3);

        const { cursor, dropped, setBaseline, writer } = setup();
        const id = await writer.insert("documents", { body: "original", title: "original", views: 0 });
        const baseline = cursor();

        // A concurrent edit to a DIFFERENT field must not block this one.
        await writer.patch(id, { title: "theirs" });

        setBaseline(baseline);
        await writer.patch(id, { body: "mine" });

        const row = await writer.get(id);

        expect(row?.["body"]).toBe("mine");
        expect(row?.["title"]).toBe("theirs");
        expect(dropped).toHaveLength(0);
    });

    it("drops the WHOLE patch when only one of its fields is stale", async () => {
        expect.assertions(3);

        const { cursor, dropped, setBaseline, writer } = setup();
        const id = await writer.insert("documents", { body: "original", title: "original", views: 0 });
        const baseline = cursor();

        await writer.patch(id, { title: "theirs" });

        // `body` is fresh and `title` is stale. Applying the fresh half would
        // leave a row no mutation ever wrote — the invariant this granularity
        // exists to protect.
        setBaseline(baseline);
        await writer.patch(id, { body: "mine", title: "mine" });

        const row = await writer.get(id);

        expect(row?.["body"]).toBe("original");
        expect(row?.["title"]).toBe("theirs");
        expect(dropped[0]?.fields).toEqual(["body", "title"]);
    });

    it("does not treat a field written back to the value the caller already saw as a conflict", async () => {
        expect.assertions(2);

        const { cursor, dropped, setBaseline, writer } = setup();
        const id = await writer.insert("documents", { body: "b", title: "original", views: 0 });
        const baseline = cursor();

        // Someone else "changed" it to the same value. Nothing moved, so a caller
        // re-sending an unchanged field must not lose its write over it.
        await writer.patch(id, { title: "original" });

        setBaseline(baseline);
        await writer.patch(id, { title: "mine" });

        const titleRow = await writer.get(id);

        expect(titleRow?.["title"]).toBe("mine");
        expect(dropped).toHaveLength(0);
    });

    it("leaves a table that did not opt in exactly as it was", async () => {
        expect.assertions(2);

        const { cursor, dropped, setBaseline, writer } = setup();
        const id = await writer.insert("notes", { body: "b", title: "original", views: 0 });
        const baseline = cursor();

        await writer.patch(id, { title: "theirs" });

        setBaseline(baseline);
        await writer.patch(id, { title: "mine" });

        const titleRow = await writer.get(id);

        expect(titleRow?.["title"]).toBe("mine");
        expect(dropped).toHaveLength(0);
    });

    it("fails open when the caller sends no baseline", async () => {
        expect.assertions(2);

        const { dropped, setBaseline, writer } = setup();
        const id = await writer.insert("documents", { body: "b", title: "original", views: 0 });

        await writer.patch(id, { title: "theirs" });

        // An unsubscribed client, or one older than this feature.
        setBaseline(undefined);
        await writer.patch(id, { title: "mine" });

        const titleRow = await writer.get(id);

        expect(titleRow?.["title"]).toBe("mine");
        expect(dropped).toHaveLength(0);
    });

    it("fails open when the changelog has no entry at or below the baseline", async () => {
        expect.assertions(2);

        const { dropped, setBaseline, writer } = setup();
        const id = await writer.insert("documents", { body: "b", title: "original", views: 0 });

        await writer.patch(id, { title: "theirs" });

        // A baseline BELOW the row's own insert — what a trimmed log looks like.
        // Discarding writes because retention ran would trade a rare lost edit for
        // a common one.
        setBaseline(0);
        await writer.patch(id, { title: "mine" });

        const titleRow = await writer.get(id);

        expect(titleRow?.["title"]).toBe("mine");
        expect(dropped).toHaveLength(0);
    });

    it("emits no changelog entry, no broadcast and no row change for a dropped patch", async () => {
        expect.assertions(3);

        runShardMigrations(harness.sql, schema, { cdc: true });

        const broadcast = vi.fn<(delta: unknown) => void>();
        let baseline: number | undefined;
        const writer = createShardContextDatabase({
            baselineSeq: () => baseline,
            broadcast,
            cdc: true,
            clock: () => 1_700_000_000_000,
            schema,
            sql: harness.sql,
        });

        const id = await writer.insert("documents", { body: "b", title: "original", views: 0 });

        baseline = readCdcCursor(harness.sql);
        await writer.patch(id, { title: "theirs" });

        const cursorBefore = readCdcCursor(harness.sql);
        const broadcasts = broadcast.mock.calls.length;

        await writer.patch(id, { title: "mine" });

        // Indistinguishable from a patch that was never issued.
        expect(readCdcCursor(harness.sql)).toBe(cursorBefore);
        expect(broadcast).toHaveBeenCalledTimes(broadcasts);

        const titleRow = await writer.get(id);

        expect(titleRow?.["title"]).toBe("theirs");
    });

    it("compares bigint and Date fields without throwing", async () => {
        expect.assertions(2);

        const wide: SchemaLike = {
            tables: {
                documents: {
                    dropStalePatchesMode: true,
                    indexes: [],
                    shape: { at: { kind: "number" }, size: { kind: "bigint" }, title: { kind: "string" } },
                },
            },
        };

        runShardMigrations(harness.sql, wide, { cdc: true });

        let baseline: number | undefined;
        const writer = createShardContextDatabase({
            baselineSeq: () => baseline,
            broadcast: () => undefined,
            cdc: true,
            clock: () => 1_700_000_000_000,
            schema: wide,
            sql: harness.sql,
        });

        const id = await writer.insert("documents", { at: 1, size: 9_007_199_254_740_993n, title: "t" });

        baseline = readCdcCursor(harness.sql);
        await writer.patch(id, { size: 42n });

        // The plain stable stringifier throws on a bigint; the comparison has to
        // use the wire-safe one or this write path dies on a perfectly ordinary row.
        await writer.patch(id, { size: 7n });

        const sizeRow = await writer.get(id);

        expect(sizeRow?.["size"]).toBe(42n);

        // A field that did NOT move still applies, bigint neighbours and all.
        await writer.patch(id, { title: "fresh" });

        const titleRow = await writer.get(id);

        expect(titleRow?.["title"]).toBe("fresh");
    });
});
