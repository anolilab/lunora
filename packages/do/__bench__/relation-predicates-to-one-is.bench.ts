import type { DatabaseWriterLike } from "@lunora/shard-engine";
import { beforeAll, bench, describe } from "vitest";

import { broadUser, makeSeededRelationWriter } from "./relation-predicates.shared";

/**
 * To-one `{ author: { is: W } }` — correlated `EXISTS` push-down vs the universal
 * semijoin (child query → flat `IN`). On the JSON-blob dialect the semijoin is
 * markedly faster for the common large-parent/small-child shape; the push-down's
 * value is escaping the key cap, not raw latency. Read the summary ratios before
 * assuming push-down wins.
 */
let pushWriter: DatabaseWriterLike;
let semijoinWriter: DatabaseWriterLike;

beforeAll(async () => {
    pushWriter = await makeSeededRelationWriter("always");
    semijoinWriter = await makeSeededRelationWriter("never");
});

describe("to-one `is` — EXISTS push-down vs semijoin (broad match)", () => {
    bench("push-down: messages where author.is(broad)", async () => {
        await pushWriter.findMany("messages", { limit: 50, where: { author: { is: broadUser } } });
    });

    bench("semijoin: messages where author.is(broad)", async () => {
        await semijoinWriter.findMany("messages", { limit: 50, where: { author: { is: broadUser } } });
    });
});
