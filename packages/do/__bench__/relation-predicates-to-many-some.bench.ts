import type { DatabaseWriterLike } from "@lunora/shard-engine";
import { beforeAll, bench, describe } from "vitest";

import { makeSeededRelationWriter } from "./relation-predicates.shared";

/**
 * To-many `{ messages: { some: W } }` — `EXISTS` push-down vs semijoin over the
 * child message set. See `relation-predicates-to-one-is.bench.ts` for the shared
 * caveat on reading the ratios.
 */
let pushWriter: DatabaseWriterLike;
let semijoinWriter: DatabaseWriterLike;

beforeAll(async () => {
    pushWriter = await makeSeededRelationWriter("always");
    semijoinWriter = await makeSeededRelationWriter("never");
});

describe("to-many `some` — EXISTS push-down vs semijoin (broad match)", () => {
    bench("push-down: users where messages.some(broad body)", async () => {
        await pushWriter.findMany("users", { limit: 50, where: { messages: { some: { body: { contains: "1" } } } } });
    });

    bench("semijoin: users where messages.some(broad body)", async () => {
        await semijoinWriter.findMany("users", { limit: 50, where: { messages: { some: { body: { contains: "1" } } } } });
    });
});
