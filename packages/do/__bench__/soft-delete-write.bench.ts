import type { DatabaseWriterLike, SchemaLike } from "@lunora/shard-engine";
import { beforeAll, bench, describe } from "vitest";

import { makeWriter } from "./shared";

/**
 * The soft-delete WRITE round-trip on a `.softDelete()` table that also carries
 * a `.rankIndex()` — the path that does the most extra work: `delete()` stamps
 * the marker, drops the rank-companion entry, and fires `onWrite("delete")`,
 * then `restore()` clears the marker and force-re-inserts the rank entry. A
 * delete+restore pair is stationary (the row returns to live each iteration), so
 * it's safe for CodSpeed's repeated runner — unlike a bare delete, which would
 * empty the table.
 *
 * The seed row is built in `beforeAll` (not at module scope) so it lives in the
 * same context the measured body runs in — see `write-throughput-patch.bench.ts`.
 */
const SEED_ID = "seed";

const schema: SchemaLike = {
    tables: {
        scores: {
            indexes: [],
            rankIndexes: [{ name: "by_score", on: "scores", sortBy: [{ direction: "desc", field: "score" }] }],
            shape: { deletedAt: { kind: "number" }, score: { kind: "number" } },
            softDeleteMode: { field: "deletedAt" },
        },
    },
};

let writer: DatabaseWriterLike;

beforeAll(async () => {
    writer = makeWriter(schema);
    await writer.insert("scores", { _id: SEED_ID, score: 10 }, { allowExplicitId: true });
});

describe("write throughput — soft delete", () => {
    bench("soft delete + restore round-trip (rank-companion drop + re-add)", async () => {
        // delete() → soft delete (marker UPDATE, rank entry dropped, onWrite delete)
        await writer.delete(SEED_ID, "scores");
        // restore() → clears the marker + force-re-inserts the rank entry
        await writer.restore?.(SEED_ID, "scores");
    });
});
