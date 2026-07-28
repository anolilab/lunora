import type { DatabaseWriterLike } from "@lunora/shard-engine";
import { beforeAll, bench, describe } from "vitest";

import { makeSeededRelationWriter } from "./relation-predicates.shared";

/**
 * No-relation fast path — a flat predicate on a relation-bearing table must NOT
 * pay for the feature beyond one synchronous `containsRelationPredicate` scan of
 * `where`. Pins the overhead of the relation-predicate machinery on the common
 * read that never crosses a relation.
 */
let writer: DatabaseWriterLike;

beforeAll(async () => {
    writer = await makeSeededRelationWriter("always");
});

describe("no-relation fast path — containsRelationPredicate overhead", () => {
    bench("flat where on a relation-bearing table (no relation predicate)", async () => {
        await writer.findMany("messages", { limit: 50, where: { body: { contains: "99" } } });
    });
});
