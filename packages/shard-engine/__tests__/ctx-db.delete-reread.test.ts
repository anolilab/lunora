import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { SchemaLike } from "../src/ctx-db";
import { createShardCtxDb as createShardContextDatabase, runShardMigrations } from "../src/ctx-db";
import createSqliteExec from "./_helpers/node-sqlite";

let harness: ReturnType<typeof createSqliteExec>;

const rereadTables = (schema: SchemaLike): ReadonlySet<string> | undefined => {
    runShardMigrations(harness.sql, schema);

    return createShardContextDatabase({ clock: () => 1_700_000_000_000, schema, sql: harness.sql }).deleteRereadTables;
};

const onDeleteTrigger = { handler: () => undefined, op: "delete", timing: "after" } as const;
const onUpdateTrigger = { handler: () => undefined, op: "update", timing: "after" } as const;
const holds = (table: string, onDelete: "cascade" | "restrict" | "set null") => ({ field: "ref", kind: "one", onDelete, references: "_id", table }) as const;

describe("ctx-db deleteRereadTables", () => {
    beforeEach(() => {
        harness = createSqliteExec();
    });

    afterEach(() => {
        harness.close();
    });

    it("lists a table whose delete cascades through another table back to itself", () => {
        expect.assertions(2);

        // Deleting a `t` row cascades its `u` holders; deleting a `u` row sets its `t` holders' reference to null.
        const listed = rereadTables({
            tables: {
                t: { indexes: [], relationMap: { u: holds("u", "set null") }, shape: { ref: { kind: "string" } } },
                u: { indexes: [], relationMap: { t: holds("t", "cascade") }, shape: { ref: { kind: "string" } } },
            },
        });

        expect(listed?.has("t")).toBe(true);
        expect(listed?.has("u")).toBe(true);
    });

    it("lists a table whose cascade reaches another table's delete trigger", () => {
        expect.assertions(2);

        const listed = rereadTables({
            tables: {
                t: { indexes: [], shape: { ref: { kind: "string" } } },
                u: { indexes: [], relationMap: { t: holds("t", "cascade") }, shape: { ref: { kind: "string" } }, triggerMap: { onGone: onDeleteTrigger } },
            },
        });

        expect(listed?.has("t")).toBe(true);
        expect(listed?.has("u")).toBe(true);
    });

    it("lists a table whose set-null reaches a holder with an update trigger, but not one whose cascade does", () => {
        expect.assertions(2);

        const listed = rereadTables({
            tables: {
                // `u` is patched (set null) when a `t` row goes, so its update trigger fires.
                t: { indexes: [], shape: { ref: { kind: "string" } } },
                u: { indexes: [], relationMap: { t: holds("t", "set null") }, shape: { ref: { kind: "string" } }, triggerMap: { onEdit: onUpdateTrigger } },
                // `w` is deleted (cascade) when an `x` row goes: delete triggers fire, update triggers do not.
                w: { indexes: [], relationMap: { x: holds("x", "cascade") }, shape: { ref: { kind: "string" } }, triggerMap: { onEdit: onUpdateTrigger } },
                x: { indexes: [], shape: { ref: { kind: "string" } } },
            },
        });

        expect(listed?.has("t")).toBe(true);
        expect(listed?.has("x")).toBe(false);
    });

    it("lists a table with its own delete trigger or a .global() table", () => {
        expect.assertions(3);

        const listed = rereadTables({
            tables: {
                g: { indexes: [], shape: {}, shardMode: { kind: "global" } },
                p: { indexes: [], shape: {} },
                t: { indexes: [], shape: {}, triggerMap: { onGone: onDeleteTrigger } },
            },
        });

        expect(listed?.has("t")).toBe(true);
        expect(listed?.has("g")).toBe(true);
        expect(listed?.has("p")).toBe(false);
    });

    it("leaves a table off when nothing it can reach loops back or has a delete trigger", () => {
        expect.assertions(3);

        // `t` holds a reference to `v` (deleting `t` never touches `v`); a `restrict` holder does not propagate.
        const listed = rereadTables({
            tables: {
                t: { indexes: [], relationMap: { v: holds("v", "cascade") }, shape: { ref: { kind: "string" } } },
                v: { indexes: [], shape: {} },
                w: { indexes: [], relationMap: { t: holds("t", "restrict") }, shape: { ref: { kind: "string" } }, triggerMap: { onGone: onDeleteTrigger } },
            },
        });

        expect(listed?.has("t")).toBe(false);
        expect(listed?.has("v")).toBe(false);
        expect(listed?.has("w")).toBe(true);
    });
});
