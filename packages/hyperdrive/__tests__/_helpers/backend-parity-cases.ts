import type { DatabaseWriterLike, SchemaLike } from "@lunora/shard-engine";
import { expect } from "vitest";

import { v } from "../../../values/src/v";

/**
 * Values a `.global()` table must treat the same on every engine, run against a
 * real Postgres or MySQL. The D1 halves live in `@lunora/d1`'s workerd suite.
 *
 * A required field whose validator accepts `null` stores it, on a fresh table
 * and on one provisioned while such columns still got `NOT NULL`. An `in` /
 * `notIn` list past the engine's 65,535-parameter cap still runs. A string
 * holding U+0000 is refused with the same typed error everywhere, rather than
 * stored by two engines and a raw driver error on the third.
 *
 * Handed back as `[name, run]` pairs for each suite's own `it.each`, like
 * `rls-search-cases`.
 */
interface BackendParityTarget {
    /** Provision `schema` (migrations included) and return a writer over it. Tables of the same name from an earlier case are gone. */
    setup: (schema: SchemaLike) => Promise<DatabaseWriterLike>;
}

const nullablesSchema = (note: unknown): SchemaLike =>
    ({
        tables: {
            nullables: {
                indexes: [],
                shape: { anything: v.any(), literalNull: v.literal(null), note, onlyNull: v.null(), title: v.string() },
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
    const id = await writer.insert("nullables", { anything: null, literalNull: null, note: null, onlyNull: null, title: "t" });

    await expect(writer.get(id)).resolves.toMatchObject({ anything: null, literalNull: null, note: null, onlyNull: null, title: "t" });
};

const relaxCase = (target: BackendParityTarget) => async (): Promise<void> => {
    // Provisioned while `note` was a plain required string: its column is NOT NULL.
    await target.setup(nullablesSchema(v.string()));

    const writer = await target.setup(nullablesSchema(v.union(v.string(), v.null())));
    const id = await writer.insert("nullables", { anything: 1, literalNull: null, note: null, onlyNull: null, title: "t" });

    await expect(writer.get(id)).resolves.toMatchObject({ note: null });
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

const nulCase = (target: BackendParityTarget) => async (): Promise<void> => {
    const writer = await target.setup(wideSchema);

    await expect(writer.insert("wide", { label: "a\u0000b", n: 1 })).rejects.toMatchObject({ code: "BAD_REQUEST" });
};

const backendParityCases = (target: BackendParityTarget): [string, () => Promise<void>][] => [
    ["stores null in a required column whose validator accepts it", nullCase(target)],
    ["drops NOT NULL from such a column on a table provisioned before", relaxCase(target)],
    [`runs an in / notIn list of ${String(WIDE)} values`, wideListCase(target)],
    ["refuses a string holding U+0000 with a typed error", nulCase(target)],
];

export type { BackendParityTarget };
export default backendParityCases;
