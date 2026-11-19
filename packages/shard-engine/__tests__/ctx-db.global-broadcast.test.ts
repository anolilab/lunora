import { describe, expect, it, vi } from "vitest";

import type { BroadcastDelta, ColumnMetaLike, DatabaseWriterLike, SchemaLike, ValidatorLike } from "../src/ctx-db";
import { createShardCtxDb as createShardContextDatabase } from "../src/ctx-db";
import createSqliteExec from "./_helpers/node-sqlite";

const FIXED_CLOCK = 1_700_000_000_000;

const col = (kind: string, column: Partial<ColumnMetaLike> = {}): ValidatorLike => {
    return {
        _meta: { column: { notNull: true, ...column } },
        kind,
    };
};

const globalSchema: SchemaLike = {
    tables: { counters: { indexes: [], shape: { n: col("number") }, shardMode: { kind: "global" } } },
};

/**
 * Live subscriptions on this shard read `.global()` rows, and the write lands in D1.
 * Every write must reach `broadcast`, or a subscriber keeps the old row until a refetch.
 */
const setup = (globalOverrides: Partial<Record<"patch" | "replace" | "delete" | "patchIf" | "restore", unknown>> = {}) => {
    const deltas: Parameters<BroadcastDelta>[0][] = [];
    const globalDb = {
        delete: vi.fn<() => Promise<undefined>>(async () => undefined),
        patch: vi.fn<() => Promise<undefined>>(async () => undefined),
        patchIf: vi.fn<() => Promise<{ applied: boolean; doc: null }>>(async () => {
            return { applied: true, doc: null };
        }),
        replace: vi.fn<() => Promise<undefined>>(async () => undefined),
        ...globalOverrides,
    } as unknown as DatabaseWriterLike;
    const writer = createShardContextDatabase({
        broadcast: (delta) => deltas.push(delta),
        clock: () => FIXED_CLOCK,
        globalDb,
        schema: globalSchema,
        sql: createSqliteExec().sql,
    });

    return { deltas, writer };
};

describe("ctx.db writes on a .global() table reach live subscriptions", () => {
    it("a patch broadcasts an update for the row", async () => {
        expect.hasAssertions();

        const { deltas, writer } = setup();

        await writer.patch("counters", "g1", { n: 2 });

        expect(deltas).toStrictEqual([{ key: "g1", op: "update", table: "counters" }]);
    });

    it("a replace broadcasts an update for the row", async () => {
        expect.hasAssertions();

        const { deltas, writer } = setup();

        await writer.replace("counters", "g1", { n: 2 });

        expect(deltas).toStrictEqual([{ key: "g1", op: "update", table: "counters" }]);
    });

    it("a delete broadcasts a delete for the row", async () => {
        expect.hasAssertions();

        const { deltas, writer } = setup();

        await writer.delete("counters", "g1");

        expect(deltas).toStrictEqual([{ key: "g1", op: "delete", table: "counters" }]);
    });

    it("a restore broadcasts an update for the row", async () => {
        expect.hasAssertions();

        const { deltas, writer } = setup({ restore: vi.fn<() => Promise<undefined>>(async () => undefined) });

        await writer.restore?.("counters", "g1");

        expect(deltas).toStrictEqual([{ key: "g1", op: "update", table: "counters" }]);
    });

    it("a conditional patch broadcasts only when it applied", async () => {
        expect.hasAssertions();

        const applied = setup();

        await applied.writer.patchIf?.("counters", "g1", { patch: { n: 2 }, where: {} });

        expect(applied.deltas).toStrictEqual([{ key: "g1", op: "update", table: "counters" }]);

        const refused = setup({
            patchIf: vi.fn<() => Promise<{ applied: boolean; doc: null }>>(async () => {
                return { applied: false, doc: null };
            }),
        });

        await refused.writer.patchIf?.("counters", "g1", { patch: { n: 2 }, where: {} });

        expect(refused.deltas).toStrictEqual([]);
    });
});
