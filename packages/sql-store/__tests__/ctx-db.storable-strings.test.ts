import type { SchemaLike, ValidatorLike } from "@lunora/shard-engine";
import { describe, expect, it } from "vitest";

import type { SqlCtxExec } from "../src/ctx-db";
import { createSqlCtxDb } from "../src/ctx-db";
import { makeSqliteDialect } from "./_helpers/sqlite";

/**
 * Postgres `text` cannot store U+0000, so a write holding one is refused before it reaches the driver. The check belongs on
 * the row that will be STORED: a `v.from` column is stored as its parsed output, so a transform that produces a NUL must
 * be refused, and one that strips a NUL the caller sent must not be.
 */
const NUL = "\u0000";

/** A `v.from` whose output carries a NUL when fed `"nul"`, and is the input otherwise. */
const nulProducing = (): ValidatorLike => {
    return { _meta: { column: { notNull: true } }, kind: "from", parse: (value: unknown) => (value === "nul" ? `a${NUL}b` : value) };
};

/** A `v.from` that strips every NUL from its input. */
const nulStripping = (): ValidatorLike => {
    return { _meta: { column: { notNull: true } }, kind: "from", parse: (value: unknown) => String(value).replaceAll(NUL, "") };
};

const text = (): ValidatorLike => {
    return { _meta: { column: { notNull: true } }, kind: "string" };
};

const schema = {
    tables: { docs: { indexes: [], shape: { clean: nulStripping(), code: nulProducing(), label: text() }, shardMode: { kind: "global" } } },
} as never as SchemaLike;

const stored = { _creationTime: 1, clean: "c", code: "c", id: "d1", label: "l" };

const recordingExec = (rows: Record<string, unknown>[]): { exec: SqlCtxExec; writes: () => string[] } => {
    const statements: string[] = [];

    return {
        exec: {
            all: (query) => {
                statements.push(query);

                return Promise.resolve(rows);
            },
            run: (query) => {
                statements.push(query);

                return Promise.resolve();
            },
        },
        writes: () => statements.filter((statement) => /^\s*(?:insert into|update) ["`]?docs\b/iu.test(statement)),
    };
};

const open = (engine: "postgres" | "sqlite", rows: Record<string, unknown>[] = [stored]) => {
    const { exec, writes } = recordingExec(rows);

    return { db: createSqlCtxDb({ clock: () => 1, dialect: makeSqliteDialect(engine), exec, schema }), writes };
};

describe("createSqlCtxDb — a NUL in the stored row on Postgres", () => {
    it("refuses an insert whose transform produces a NUL", async () => {
        expect.assertions(2);

        const { db, writes } = open("postgres");

        await expect(db.insert("docs", { clean: "c", code: "nul", label: "l" })).rejects.toThrow(/NUL/u);
        expect(writes()).toHaveLength(0);
    });

    it("accepts an insert whose transform strips the NUL the caller sent", async () => {
        expect.assertions(1);

        const { db, writes } = open("postgres");

        await db.insert("docs", { clean: `a${NUL}b`, code: "ok", label: "l" });

        expect(writes()).toHaveLength(1);
    });

    it("still refuses a NUL the caller sent in a plain string column", async () => {
        expect.assertions(1);

        const { db } = open("postgres");

        await expect(db.insert("docs", { clean: "c", code: "ok", label: `a${NUL}b` })).rejects.toThrow(/NUL/u);
    });

    it("refuses a patch whose transform produces a NUL", async () => {
        expect.assertions(2);

        const { db, writes } = open("postgres");

        await expect(db.patch("docs", "d1", { code: "nul" })).rejects.toThrow(/NUL/u);
        expect(writes()).toHaveLength(0);
    });

    it("refuses a patchIf whose transform produces a NUL", async () => {
        expect.assertions(2);

        const { db, writes } = open("postgres", [{ ...stored, __lunora_patch_if_match__: 1 }]);

        await expect(db.patchIf?.("docs", "d1", { patch: { code: "nul" }, where: {} })).rejects.toThrow(/NUL/u);
        expect(writes()).toHaveLength(0);
    });

    it("accepts a patch whose transform strips the NUL the caller sent", async () => {
        expect.assertions(1);

        const { db, writes } = open("postgres");

        await db.patch("docs", "d1", { clean: `a${NUL}b` });

        expect(writes()).toHaveLength(1);
    });

    it("refuses a replace whose transform produces a NUL", async () => {
        expect.assertions(2);

        const { db, writes } = open("postgres");

        await expect(db.replace("docs", "d1", { clean: "c", code: "nul", label: "l" })).rejects.toThrow(/NUL/u);
        expect(writes()).toHaveLength(0);
    });

    it("leaves a NUL already stored in an untouched field patchable", async () => {
        expect.assertions(1);

        const { db, writes } = open("postgres", [{ ...stored, label: `a${NUL}b` }]);

        await db.patch("docs", "d1", { code: "ok" });

        expect(writes()).toHaveLength(1);
    });

    it("stores a transform's NUL on SQLite, which keeps the character", async () => {
        expect.assertions(1);

        const { db, writes } = open("sqlite");

        await db.insert("docs", { clean: "c", code: "nul", label: "l" });

        expect(writes()).toHaveLength(1);
    });
});

describe("createSqlCtxDb — a NUL in a trusted-import row id", () => {
    it.each(["postgres", "sqlite"] as const)("refuses an explicit _id holding a NUL on %s, before any write", async (engine) => {
        expect.assertions(2);

        const { db, writes } = open(engine);

        await expect(db.insert("docs", { clean: "c", code: "ok", label: "l", _id: `a${NUL}b` }, { allowExplicitId: true })).rejects.toThrow(/NUL/u);
        expect(writes()).toHaveLength(0);
    });

    it("keeps refusing a NUL-bearing id when the import is not trusted, which mints a fresh id instead", async () => {
        expect.assertions(1);

        const { db, writes } = open("sqlite");

        await db.insert("docs", { clean: "c", code: "ok", label: "l", _id: `a${NUL}b` });

        expect(writes()).toHaveLength(1);
    });
});
