import type { Schema } from "@lunora/server";
import type { TestHarness } from "@lunora/testing";

import { introspectSchema } from "./introspect";
import type { SeedOptions } from "./plan";
import { seedPlan } from "./plan";

/**
 * Seed an in-memory {@link TestHarness} (`@lunora/testing`'s `lunoraTest`).
 *
 * Runs {@link seedPlan} and inserts every generated row through `ctx.db.insert`
 * with `allowExplicitId` so the planned `_id`s — and therefore every resolved
 * foreign key — are preserved. Tables are written in FK order (parents first).
 * @returns the inserted document ids keyed by table, for assertions.
 * @example
 * const harness = lunoraTest(schema);
 * const ids = await seed(harness, schema, { counts: { users: 5, posts: 20 } });
 * expect(ids.users).toHaveLength(5);
 */

/**
 * Revive the wire representation of `v.bigint()` and `v.bytes()` columns back to
 * native JS types before inserting into the in-memory harness.
 *
 * `generateValue` emits `number` for bigint and `number[]` for bytes so the
 * values survive JSON serialisation on CLI/studio adapter paths. The harness
 * writes directly to the DO's SQLite writer, which validates against the schema
 * and therefore requires native `bigint` and `ArrayBuffer` values.
 */
const reviveRow = (row: Record<string, unknown>, bigintFields: ReadonlySet<string>, bytesFields: ReadonlySet<string>): Record<string, unknown> => {
    if (bigintFields.size === 0 && bytesFields.size === 0) {
        return row;
    }

    const revived: Record<string, unknown> = { ...row };

    for (const field of bigintFields) {
        const value = revived[field];

        if (typeof value === "number") {
            revived[field] = BigInt(value);
        }
    }

    for (const field of bytesFields) {
        const value = revived[field];

        if (Array.isArray(value)) {
            revived[field] = Uint8Array.from(value as number[]).buffer;
        }
    }

    return revived;
};

const seed = async (harness: TestHarness, schema: Schema, options: SeedOptions = {}): Promise<Record<string, string[]>> => {
    const plan = seedPlan(schema, options);

    // Pre-compute which fields need native-type revival per table so we don't pay
    // the introspection cost inside the per-row hot loop.
    const specs = introspectSchema(schema);
    const bigintFieldsByTable = new Map<string, Set<string>>();
    const bytesFieldsByTable = new Map<string, Set<string>>();

    for (const spec of specs) {
        const bigintFields = new Set(spec.fields.filter((field) => field.kind === "bigint").map((field) => field.name));
        const bytesFields = new Set(spec.fields.filter((field) => field.kind === "bytes").map((field) => field.name));

        if (bigintFields.size > 0) {
            bigintFieldsByTable.set(spec.name, bigintFields);
        }

        if (bytesFields.size > 0) {
            bytesFieldsByTable.set(spec.name, bytesFields);
        }
    }

    const ids: Record<string, string[]> = {};

    await harness.run(async (context) => {
        // `allowExplicitId` is the trusted-import path on the DO writer; it is not
        // on the public `DatabaseWriter.insert` type surfaced through the harness,
        // so the option is passed through a narrowed local reference.
        const insert = context.db.insert as (table: string, document: Record<string, unknown>, options?: { allowExplicitId?: boolean }) => Promise<string>;

        for (const { rows, table } of plan) {
            const tableIds: string[] = [];
            const bigintFields = bigintFieldsByTable.get(table) ?? new Set<string>();
            const bytesFields = bytesFieldsByTable.get(table) ?? new Set<string>();

            for (const row of rows) {
                // Sequential by design: parents must land before children so each
                // resolved foreign key references an already-inserted row.
                // eslint-disable-next-line no-await-in-loop -- ordered inserts preserve FK consistency
                tableIds.push(await insert(table, reviveRow(row, bigintFields, bytesFields), { allowExplicitId: true }));
            }

            ids[table] = tableIds;
        }
    });

    return ids;
};

// eslint-disable-next-line import/prefer-default-export -- named export: re-exported by name from `@lunora/seed/testing`, per the repo's no-default-mixing convention
export { seed };
