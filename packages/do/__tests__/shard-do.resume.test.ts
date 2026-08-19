import { createShardCtxDb as createShardContextDatabase, readCdcEpoch, runShardMigrations } from "@lunora/shard-engine";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ShardDOState } from "../src/shard-do";
import { ShardDO } from "../src/shard-do";
import messagesSchema from "./_helpers/messages-schema";
import createSqliteExec from "./_helpers/node-sqlite";

/**
 * `evaluateResume` decides whether a reconnecting subscription can replay the
 * deltas it missed (resumable) or must re-snapshot. Driven through a real SQLite
 * `__cdc_log` so the read-set intersection runs against actual changes.
 */

let harness: ReturnType<typeof createSqliteExec>;

/** A ShardDO that exposes the protected resume probe against the seeded sql. */
class ResumeShard extends ShardDO {
    // eslint-disable-next-line class-methods-use-this -- abstract stub; the resume probe never dispatches an RPC
    public override handleRpc(): Promise<unknown> {
        return Promise.resolve(undefined);
    }

    public probe(sinceSeq: number, readSet: Set<string>, sinceEpoch?: string): { cursor: number | undefined; resumable: boolean } {
        return this.evaluateResume(sinceSeq, readSet, sinceEpoch);
    }
}

/** The shard's current CDC epoch — a resume only succeeds when the client supplies a matching one. */
const currentEpoch = (): string => readCdcEpoch(harness.sql);

const buildShard = (): ResumeShard => {
    const state: ShardDOState = {
        acceptWebSocket() {
            // no sockets in these tests
        },
        getWebSockets() {
            return [];
        },
        id: { name: "shard-a" },
        storage: { sql: harness.sql },
    } as unknown as ShardDOState;

    return new ResumeShard(state, {});
};

describe("shardDO.evaluateResume", () => {
    beforeEach(async () => {
        harness = createSqliteExec();
        runShardMigrations(harness.sql, messagesSchema, { cdc: true });

        const writer = createShardContextDatabase({
            broadcast: () => undefined,
            cdc: true,
            clock: () => 1_700_000_000_000,
            schema: messagesSchema,
            sql: harness.sql,
        });

        // One committed write → a single `__cdc_log` row on the `messages` table.
        await writer.insert("messages", { _id: "m_1", authorId: "u1", channelId: "c1", text: "hi" }, { allowExplicitId: true });
    });

    afterEach(() => {
        harness.close();
    });

    it("does not resume an empty read-set (unknown deps) when newer changes exist", () => {
        expect.assertions(1);

        // Empty read-set means we never recorded the query's table deps, so we
        // can't prove they were untouched — must re-snapshot, never resume blind.
        expect(buildShard().probe(0, new Set(), currentEpoch()).resumable).toBe(false);
    });

    it("resumes when no read-set table changed since the cursor", () => {
        expect.assertions(1);

        // The change touched `messages`; a query reading only `users` is unaffected.
        expect(buildShard().probe(0, new Set(["users"]), currentEpoch()).resumable).toBe(true);
    });

    it("does not resume when a read-set table changed since the cursor", () => {
        expect.assertions(1);

        expect(buildShard().probe(0, new Set(["messages"]), currentEpoch()).resumable).toBe(false);
    });

    it("resumes trivially when the client is already at the high-watermark", () => {
        expect.assertions(1);

        // `sinceSeq === cursor`: nothing newer exists, current regardless of deps.
        expect(buildShard().probe(1, new Set(), currentEpoch()).resumable).toBe(true);
    });

    it("does not resume when the client's epoch does not match (timeline fork)", () => {
        expect.assertions(1);

        // A reset / recycled-shard advertises a fresh epoch; the client's cached
        // epoch no longer matches, so its `sinceSeq` names an unrelated timeline.
        expect(buildShard().probe(1, new Set(["users"]), "stale-epoch").resumable).toBe(false);
    });

    it("does not resume without an epoch (pre-epoch client)", () => {
        expect.assertions(1);

        // A client that supplies `sinceSeq` but no epoch can't prove it shares
        // this timeline — re-snapshot.
        expect(buildShard().probe(1, new Set(["users"])).resumable).toBe(false);
    });

    it("does not resume when sinceSeq exceeds the cursor (rollback guard)", () => {
        expect.assertions(1);

        // A `sinceSeq` past the high-watermark under a matching epoch means the
        // log rolled back (e.g. PITR) — re-snapshot rather than trust it.
        expect(buildShard().probe(99, new Set(["users"]), currentEpoch()).resumable).toBe(false);
    });

    it("resumes a client that is tens of thousands of changes behind on an untouched read-set", async () => {
        expect.assertions(2);

        const writer = createShardContextDatabase({
            broadcast: () => undefined,
            cdc: true,
            clock: () => 1_700_000_000_000,
            schema: messagesSchema,
            sql: harness.sql,
        });

        // Well past the 10 000-row page the resume check used to scan. That cap
        // meant the client with the MOST to gain from a delta — offline long
        // enough to accumulate a big range — was the one guaranteed to be re-sent
        // its whole query result, because the check could not see far enough to
        // prove the range was irrelevant to it.
        for (let index = 0; index < 12_000; index += 1) {
            // eslint-disable-next-line no-await-in-loop -- sequential writes are the point: they build one long changelog range
            await writer.insert(
                "messages",
                { _id: `bulk_${String(index)}`, authorId: "u1", channelId: "c1", text: `x${String(index)}` },
                { allowExplicitId: true },
            );
        }

        const shard = buildShard();

        // None of those 12 000 changes touched `users`, so a query reading only
        // `users` is still current and resumes.
        expect(shard.probe(0, new Set(["users"]), currentEpoch()).resumable).toBe(true);

        // The verdict is still a real intersection, not a blanket yes: a query
        // that DOES read the written table must re-snapshot.
        expect(shard.probe(0, new Set(["messages"]), currentEpoch()).resumable).toBe(false);
    });
});
