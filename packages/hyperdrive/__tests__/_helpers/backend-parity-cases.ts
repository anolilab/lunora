import type { DatabaseWriterLike, SchemaLike } from "@lunora/shard-engine";
import { expect, vi } from "vitest";

import { v } from "../../../values/src/v";

/**
 * Values a `.global()` table must treat the same on every engine, run against a
 * real Postgres or MySQL. The D1 halves live in `@lunora/d1`'s workerd suite.
 *
 * A required field whose validator accepts `null` stores it on a fresh table. On
 * one provisioned while such columns still got `NOT NULL`, Postgres drops the
 * constraint at startup and MySQL leaves the column exactly as it is and names
 * the statement to run. An `in` / `notIn` list past the engine's 65,535-parameter
 * cap still runs. A string holding U+0000 is refused with a typed error where
 * the engine cannot store one (Postgres), and an existing row holding one stays
 * patchable and re-importable where it can.
 *
 * Handed back as `[name, run]` pairs for each suite's own `it.each`, like
 * `rls-search-cases`.
 */
interface BackendParityTarget {
    /** `"mysql"` gets the case-folding-collation case. */
    engine: "mysql" | "postgres";
    /** Run raw SQL on the engine, e.g. to recreate a table the way an older build provisioned it. */
    query: (statement: string) => Promise<Record<string, unknown>[]>;
    /** Provision `schema` (migrations included) and return a writer over it. Tables of the same name from an earlier case are gone. */
    setup: (schema: SchemaLike) => Promise<DatabaseWriterLike>;
}

const nullablesSchema = (note: unknown): SchemaLike =>
    ({
        tables: {
            nullables: {
                indexes: [],
                shape: {
                    anything: v.any(),
                    literalNull: v.literal(null),
                    note,
                    nullableMember: v.union(v.string().nullable(), v.number()),
                    onlyNull: v.null(),
                    title: v.string(),
                },
                shardMode: { kind: "global" },
            },
        },
    }) as unknown as SchemaLike;

const wideSchema = { tables: { wide: { indexes: [], shape: { label: v.string(), n: v.number() }, shardMode: { kind: "global" } } } } as unknown as SchemaLike;

/** Past both engines' 65,535 bound-parameter cap on its own. */
const WIDE = 70_000;

const DECOY_LABELS = Array.from({ length: WIDE }, (_, index) => `decoy-${String(index)}`);
const DECOY_NUMBERS = Array.from({ length: WIDE }, (_, index) => 1000 + index);

const nullCase = (target: BackendParityTarget) => async (): Promise<void> => {
    const writer = await target.setup(nullablesSchema(v.union(v.string(), v.null())));
    const id = await writer.insert("nullables", { anything: null, literalNull: null, note: null, nullableMember: null, onlyNull: null, title: "t" });

    await expect(writer.get(id)).resolves.toMatchObject({ anything: null, literalNull: null, note: null, nullableMember: null, onlyNull: null, title: "t" });
};

const relaxCase = (target: BackendParityTarget) => async (): Promise<void> => {
    if (target.engine === "mysql") {
        expect(target.engine).toBe("mysql");

        return;
    }

    // Provisioned while `note` was a plain required string: its column is NOT NULL.
    await target.setup(nullablesSchema(v.string()));

    const writer = await target.setup(nullablesSchema(v.union(v.string(), v.null())));
    const id = await writer.insert("nullables", { anything: 1, literalNull: null, note: null, nullableMember: 1, onlyNull: null, title: "t" });

    await expect(writer.get(id)).resolves.toMatchObject({ note: null });
};

/** The declaration information_schema holds for `nullables.note`. */
const noteColumn = async (target: BackendParityTarget): Promise<Record<string, unknown>> => {
    const [row] = await target.query(
        "SELECT COLUMN_TYPE AS type, COLLATION_NAME AS collation, IS_NULLABLE AS nullable FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'nullables' AND column_name = 'note'",
    );

    return row ?? {};
};

const mysqlNoRelaxCase = (target: BackendParityTarget) => async (): Promise<void> => {
    if (target.engine !== "mysql") {
        expect(target.engine).toBe("postgres");

        return;
    }

    // A legacy column: case-folding collation, and LONGTEXT where the current
    // DDL would declare something else. Rewriting it at startup would change how
    // it compares and rebuild the table under live traffic.
    await target.query(
        "CREATE TABLE `nullables` (`id` VARCHAR(768) PRIMARY KEY, `_creationTime` DOUBLE NOT NULL, `note` LONGTEXT COLLATE utf8mb4_0900_ai_ci NOT NULL)",
    );
    await target.query("INSERT INTO `nullables` (`id`, `_creationTime`, `note`) VALUES ('a', 1, 'Alice')");

    const before = await noteColumn(target);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    try {
        const writer = await target.setup(nullablesSchema(v.union(v.string(), v.null())));

        await expect(noteColumn(target)).resolves.toStrictEqual(before);
        expect(before).toMatchObject({ collation: "utf8mb4_0900_ai_ci", nullable: "NO" });
        // Still compares the way it always did.
        await expect(writer.findMany("nullables", { where: { note: "alice" } })).resolves.toMatchObject({ page: [{ _id: "a" }] });
        // And the operator is told the exact statement, keeping type and collation.
        expect(warn.mock.calls.map((call) => String(call[0])).join("\n")).toContain(
            "ALTER TABLE `nullables` MODIFY COLUMN `note` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NULL",
        );
    } finally {
        warn.mockRestore();
    }
};

const wideListCase = (target: BackendParityTarget) => async (): Promise<void> => {
    const writer = await target.setup(wideSchema);

    await writer.insert("wide", { label: "hit", n: 7 });
    await writer.insert("wide", { label: "miss", n: 8 });

    const labelsWhere = async (where: Record<string, unknown>): Promise<unknown[]> => {
        const result = await writer.findMany("wide", { where });

        return result.page.map((row) => row["label"]);
    };

    await expect(labelsWhere({ label: { in: [...DECOY_LABELS, "hit"] } })).resolves.toStrictEqual(["hit"]);
    await expect(labelsWhere({ n: { in: [...DECOY_NUMBERS, 7] } })).resolves.toStrictEqual(["hit"]);
    await expect(labelsWhere({ label: { notIn: [...DECOY_LABELS, "hit"] } })).resolves.toStrictEqual(["miss"]);
};

const severalWideListsCase = (target: BackendParityTarget) => async (): Promise<void> => {
    const writer = await target.setup(wideSchema);

    await writer.insert("wide", { label: "hit", n: 7 });

    // Seven lists of 10,000: each small enough to stay literal on its own, 70,000
    // placeholders together — past both engines' 65,535 cap.
    const lists = Array.from({ length: 7 }, (_, list) => {
        return { label: { in: [...DECOY_LABELS.slice(list * 10_000, list * 10_000 + 9999), "hit"] } };
    });
    const result = await writer.findMany("wide", { where: { AND: lists } });

    expect(result.page.map((row) => row["label"])).toStrictEqual(["hit"]);
};

const legacyCollationCase = (target: BackendParityTarget) => async (): Promise<void> => {
    if (target.engine !== "mysql") {
        expect(target.engine).toBe("postgres");

        return;
    }

    // Provisioned the way a table created before text columns were pinned to a
    // binary collation is: case-folding. A literal `IN` matches case-blind
    // there, and so must the wide one.
    await target.query(
        "CREATE TABLE `wide` (`id` VARCHAR(768) PRIMARY KEY, `_creationTime` DOUBLE NOT NULL, `_version` BIGINT, `label` LONGTEXT COLLATE utf8mb4_0900_ai_ci NOT NULL, `n` DOUBLE NOT NULL)",
    );

    const writer = await target.setup(wideSchema);

    await writer.insert("wide", { label: "Alice", n: 1 });

    const narrow = await writer.findMany("wide", { where: { label: { in: ["alice"] } } });
    const wide = await writer.findMany("wide", { where: { label: { in: [...DECOY_LABELS, "alice"] } } });

    expect(narrow.page).toHaveLength(1);
    expect(wide.page).toHaveLength(1);
};

const nulCase = (target: BackendParityTarget) => async (): Promise<void> => {
    const writer = await target.setup(wideSchema);

    if (target.engine === "postgres") {
        // Postgres TEXT cannot hold one: a typed error on the field written, not a driver error.
        await expect(writer.insert("wide", { label: "a\u0000b", n: 1 })).rejects.toMatchObject({ code: "BAD_REQUEST" });

        const id = await writer.insert("wide", { label: "ok", n: 1 });

        await expect(writer.patch(id, { label: "a\u0000b" })).rejects.toMatchObject({ code: "BAD_REQUEST" });

        return;
    }

    // MySQL stores it — and a row an earlier build stored with one stays
    // patchable and re-importable, although the caller is not writing the NUL.
    const id = "w1";

    await target.query("INSERT INTO `wide` (`id`, `_creationTime`, `label`, `n`) VALUES ('w1', 1, CONCAT('a', CHAR(0), 'b'), 1)");
    await writer.patch(id, { n: 2 });

    const stored = await writer.get(id);

    expect(stored).toMatchObject({ label: "a\u0000b", n: 2 });

    await writer.delete(id);

    await expect(writer.insert("wide", stored as never, { allowExplicitId: true })).resolves.toBe(id);
};

const backendParityCases = (target: BackendParityTarget): [string, () => Promise<void>][] => [
    ["stores null in a required column whose validator accepts it", nullCase(target)],
    ["drops NOT NULL from such a column on a table provisioned before (Postgres)", relaxCase(target)],
    ["leaves such a legacy MySQL column untouched and names the ALTER to run", mysqlNoRelaxCase(target)],
    [`runs an in / notIn list of ${String(WIDE)} values`, wideListCase(target)],
    ["keeps several wide lists in one where under the parameter cap together", severalWideListsCase(target)],
    ["matches a wide string list under the column's own collation", legacyCollationCase(target)],
    ["refuses U+0000 only where the engine cannot store it, and never on an existing row", nulCase(target)],
];

export type { BackendParityTarget };
export default backendParityCases;
