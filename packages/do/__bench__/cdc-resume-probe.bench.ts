import type { SchemaLike } from "@lunora/shard-engine";
import { bench, describe } from "vitest";

import { ShardDO } from "../src/shard-do";
import { makeCdcShardFixture } from "./shared";

/**
 * `evaluateResume` decides whether a reconnecting subscription can keep its
 * cached value or must be re-sent the whole query result. The question it
 * answers is set-membership — "did anything in `(sinceSeq, head]` touch a table
 * this query reads?" — and the interesting property is how its cost moves as
 * that range grows.
 *
 * It used to move linearly: the check read a page of up to 10 000 changes WITH
 * their post-image documents and tested `.some()` over them, so a client that
 * had been away longer paid more to be told nothing had changed — and past the
 * page cap it was not told at all, it was re-snapshotted. This bench varies only
 * the range size, so the shape of the curve is the measurement:
 *
 * - **near** — 100 changes behind, the reconnect-after-a-blip case.
 * - **far** — 5 000 changes behind, inside the old page.
 * - **beyond the old cap** — 15 000 changes behind, where the old path stopped
 * answering and forced a full re-send.
 * - **touched** — the same large range, but the read-set DOES intersect it: the
 * early-exit direction, which should be cheaper still.
 *
 * A flat line across the first three is the property Linear reports from moving
 * this question onto an index, and the one this path now has.
 */

/** Documents are padded to ~512 bytes so the cost of decoding them is visible against the cost of finding them. */
const benchSchema = {
    tables: {
        messages: {
            indexes: [{ fields: ["channelId"], name: "by_channel" }],
            shape: { authorId: { kind: "string" }, channelId: { kind: "string" }, text: { kind: "string" } },
        },
        users: { indexes: [], shape: { name: { kind: "string" } } },
    },
} as unknown as SchemaLike;

/** Exposes the protected resume probe. */
class ResumeBenchShard extends ShardDO {
    // eslint-disable-next-line class-methods-use-this -- bench stub; the resume probe never dispatches an RPC
    public override handleRpc(): Promise<unknown> {
        return Promise.resolve(null);
    }

    public probe(readSet: Set<string>): boolean {
        return this.evaluateResume(0, readSet, this.epoch()).resumable;
    }

    private epoch(): string | undefined {
        return this.currentCdcEpoch();
    }
}

/** Build a shard over a changelog holding `changes` writes to `messages`. */
const buildShard = async (changes: number): Promise<ResumeBenchShard> => {
    const { state, writer } = makeCdcShardFixture(benchSchema);

    for (let index = 0; index < changes; index += 1) {
        // eslint-disable-next-line no-await-in-loop -- sequential writes are the fixture: they build one contiguous changelog range
        await writer.insert(
            "messages",
            { _id: `m${String(index)}`, authorId: "u1", channelId: "c1", text: `t${String(index)}`.padEnd(512, "x") },
            { allowExplicitId: true },
        );
    }

    return new ResumeBenchShard(state, {});
};

const UNTOUCHED = new Set(["users"]);
const TOUCHED = new Set(["messages"]);

describe("evaluateResume — cost vs how far behind the client is", async () => {
    const near = await buildShard(100);
    const far = await buildShard(5000);
    const beyond = await buildShard(15_000);

    bench("near — 100 changes behind, read-set untouched", () => {
        near.probe(UNTOUCHED);
    });

    bench("far — 5 000 changes behind, read-set untouched", () => {
        far.probe(UNTOUCHED);
    });

    bench("beyond the old 10 000 scan cap — 15 000 changes behind, read-set untouched", () => {
        beyond.probe(UNTOUCHED);
    });

    bench("beyond the old cap — 15 000 changes behind, read-set TOUCHED (early exit)", () => {
        beyond.probe(TOUCHED);
    });
});
