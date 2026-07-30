import type { DatabaseWriterLike, SchemaLike } from "@lunora/shard-engine";
import { beforeAll, bench, describe } from "vitest";

import { makeWriter } from "./shared";

/**
 * The work behind `ctx.db.&lt;table>.upsert(...)` — a `findFirst` by the unique
 * `target` followed by a `patch` (match) or `insert` (miss). The facade is a
 * thin wrapper over exactly these calls, so this engine-level pair is a faithful
 * measure of upsert's cost. The `by_email` UNIQUE index backs the lookup.
 *
 * Only the UPDATE path is benched: it is stationary (the table size never
 * changes), so CodSpeed's repeated runner stays clean. The CREATE path is just
 * `findFirst`-miss + `insert`, whose halves are already covered by the
 * `write-throughput-insert-*` and `findMany` benches; benching it here would
 * grow the table unboundedly and skew the measurement.
 */
const schema: SchemaLike = {
    tables: {
        users: {
            indexes: [{ fields: ["email"], name: "by_email", unique: true }],
            shape: { email: { kind: "string" }, name: { kind: "string" } },
        },
    },
};

const EMAIL = "exists@x.dev";

let writer: DatabaseWriterLike;
let counter = 0;

beforeAll(async () => {
    writer = makeWriter(schema);
    await writer.insert("users", { _id: "u-existing", email: EMAIL, name: "seed" }, { allowExplicitId: true });
});

describe("upsert pattern (findFirst by unique target + patch/insert)", () => {
    bench("upsert — update path (existing row: findFirst hit + patch)", async () => {
        counter += 1;

        const existing = await writer.findFirst("users", { where: { email: EMAIL } });
        const id = existing?.["_id"];

        await (typeof id === "string"
            ? writer.patch(id, { name: `n${String(counter)}` })
            : writer.insert("users", { email: EMAIL, name: `n${String(counter)}` }));
    });
});
