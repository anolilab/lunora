import type { DatabaseWriterLike } from "@lunora/shard-engine";
import { beforeAll, bench, describe } from "vitest";

import { broadUser, makeSeededRelationWriter } from "./relation-predicates.shared";

/**
 * Multi-hop `reactions → message → author` — `EXISTS` push-down vs semijoin
 * across two relation hops. See `relation-predicates-to-one-is.bench.ts` for the
 * shared caveat on reading the ratios.
 */
let pushWriter: DatabaseWriterLike;
let semijoinWriter: DatabaseWriterLike;

beforeAll(async () => {
    pushWriter = await makeSeededRelationWriter("always");
    semijoinWriter = await makeSeededRelationWriter("never");
});

describe("multi-hop `reactions → message → author` — push-down vs semijoin", () => {
    bench("push-down: reactions where message.is(author.is(broad))", async () => {
        await pushWriter.findMany("reactions", { limit: 50, where: { message: { is: { author: { is: broadUser } } } } });
    });

    bench("semijoin: reactions where message.is(author.is(broad))", async () => {
        await semijoinWriter.findMany("reactions", { limit: 50, where: { message: { is: { author: { is: broadUser } } } } });
    });
});
