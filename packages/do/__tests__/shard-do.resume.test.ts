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

    public probe(sinceSeq: number, readSet: Set<string>, sinceEpoch?: string): { cursor: number | undefined; epoch: string | undefined; resumable: boolean } {
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
        // An instance of the vouch rule, not a case of its own: an unrecorded
        // dependency is one the changelog cannot speak for.
        expect(buildShard().probe(0, new Set(), currentEpoch()).resumable).toBe(false);
    });

    it("resumes when no read-set table changed since the cursor", () => {
        expect.assertions(1);

        // The change touched `messages`; a query reading only `roomMembers` is unaffected.
        expect(buildShard().probe(0, new Set(["roomMembers"]), currentEpoch()).resumable).toBe(true);
    });

    it("does not resume when a read-set table changed since the cursor", () => {
        expect.assertions(1);

        expect(buildShard().probe(0, new Set(["messages"]), currentEpoch()).resumable).toBe(false);
    });

    it("resumes trivially when the client is already at the high-watermark", () => {
        expect.assertions(2);

        const shard = buildShard();

        // `sinceSeq === cursor`: nothing newer exists in a log that can speak for
        // the whole read-set, so the client is current.
        expect(shard.probe(1, new Set(["roomMembers"]), currentEpoch()).resumable).toBe(true);

        // But only for a read-set the log CAN speak for. Sitting at the
        // high-watermark says nothing about deps it never records, and an
        // unrecorded read-set may well contain one — the cursor of a shard whose
        // `.global()` table just changed is exactly this unchanged.
        expect(shard.probe(1, new Set(), currentEpoch()).resumable).toBe(false);
    });

    it("does not resume when the client's epoch does not match (timeline fork)", () => {
        expect.assertions(1);

        // A reset / recycled-shard advertises a fresh epoch; the client's cached
        // epoch no longer matches, so its `sinceSeq` names an unrelated timeline.
        expect(buildShard().probe(1, new Set(["roomMembers"]), "stale-epoch").resumable).toBe(false);
    });

    it("does not resume without an epoch (pre-epoch client)", () => {
        expect.assertions(1);

        // A client that supplies `sinceSeq` but no epoch can't prove it shares
        // this timeline — re-snapshot.
        expect(buildShard().probe(1, new Set(["roomMembers"])).resumable).toBe(false);
    });

    it("does not resume when sinceSeq exceeds the cursor (rollback guard)", () => {
        expect.assertions(1);

        // A `sinceSeq` past the high-watermark under a matching epoch means the
        // log rolled back (e.g. PITR) — re-snapshot rather than trust it.
        expect(buildShard().probe(99, new Set(["roomMembers"]), currentEpoch()).resumable).toBe(false);
    });

    it("does not resume a read of a `.global()` table, which no changelog records", () => {
        expect.assertions(2);

        // `profiles` is `.global()`: its rows live in D1 and NO shard ever writes
        // a `__cdc_log` entry for them, so the changelog's "nothing changed" is a
        // claim it cannot support. The dangerous cell is the client sitting
        // exactly AT the high-watermark — a global write bumps no cursor here, so
        // that is precisely the state a client that missed one arrives in.
        const shard = buildShard();

        expect(shard.probe(1, new Set(["profiles"]), currentEpoch()).resumable).toBe(false);
        expect(shard.probe(0, new Set(["profiles", "roomMembers"]), currentEpoch()).resumable).toBe(false);
    });

    it("does not resume a flags/admin wildcard read", () => {
        expect.assertions(2);

        // A `useFlag` subscription stamps the `"*"` sentinel, which names no
        // table: a flag flipped in the provider touches no SQLite row anywhere,
        // so the log has nothing to say about it. Falls out of the same rule as
        // the global-table case rather than being special-cased.
        const shard = buildShard();

        expect(shard.probe(1, new Set(["*"]), currentEpoch()).resumable).toBe(false);
        expect(shard.probe(0, new Set(["*"]), currentEpoch()).resumable).toBe(false);
    });

    it("does not resume a dependency it does not recognise at all", () => {
        expect.assertions(1);

        // `users` is not a table in this shard's SQLite. Whatever such a name
        // came from — a table on another shard, a capability stamped after this
        // rule was written — the changelog cannot speak for it, and the DEFAULT
        // has to be "re-snapshot" so a new read source is safe by construction.
        expect(buildShard().probe(0, new Set(["users"]), currentEpoch()).resumable).toBe(false);
    });

    it("seals the timeline for every client once one proves the log rolled back", () => {
        expect.assertions(3);

        const shard = buildShard();
        const beforeFork = currentEpoch();

        // A PITR restore reverts all of SQLite, the epoch row included, so the
        // proactive bump `pitrRestore` performs is rolled back with it. The only
        // surviving record of the pre-restore timeline is the cursor a CLIENT
        // cached: this one holds seq 40 against a log the restore rewound to 1.
        const forked = shard.probe(40, new Set(["roomMembers"]), beforeFork);

        expect(forked.resumable).toBe(false);
        expect(forked.epoch).not.toBe(beforeFork);

        // The client the rollback guard alone cannot save: it cached BELOW the
        // restore point, so `sinceSeq <= cursor` holds and its read-set is
        // genuinely untouched in the rewound log. Only the sealed epoch stops it
        // from resuming onto rows the restore rolled back.
        expect(shard.probe(0, new Set(["roomMembers"]), beforeFork).resumable).toBe(false);
    });

    it("seals at most once per wake, so a forged proof cannot re-seal on demand", () => {
        expect.assertions(3);

        const shard = buildShard();
        const beforeFork = currentEpoch();

        // The proof this acts on is client-supplied, and the epoch it has to
        // match is stamped on every frame the client has already received — so
        // any subscriber can manufacture it. Unbounded, each forged frame would
        // cost a SQLite write and invalidate every other subscriber's cached
        // resume: one cheap request amplified into N full snapshots.
        const firstSeal = shard.probe(40, new Set(["roomMembers"]), beforeFork).epoch;

        expect(firstSeal).not.toBe(beforeFork);

        // A second forged proof — now against the sealed epoch, which the
        // attacker can read straight off the frame it just got back.
        const secondSeal = shard.probe(9999, new Set(["roomMembers"]), firstSeal).epoch;

        expect(secondSeal).toBe(firstSeal);

        // And the seal it already performed still holds, so capping it costs the
        // genuine restore nothing: one seal is all a real fork needs.
        expect(shard.probe(0, new Set(["roomMembers"]), beforeFork).resumable).toBe(false);
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

        // None of those 12 000 changes touched `roomMembers`, so a query reading
        // only `roomMembers` is still current and resumes.
        expect(shard.probe(0, new Set(["roomMembers"]), currentEpoch()).resumable).toBe(true);

        // The verdict is still a real intersection, not a blanket yes: a query
        // that DOES read the written table must re-snapshot.
        expect(shard.probe(0, new Set(["messages"]), currentEpoch()).resumable).toBe(false);
    });
});
