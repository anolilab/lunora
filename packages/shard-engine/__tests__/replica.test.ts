import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ExportRow } from "../src/admin-export-import";
import type { SqlExec } from "../src/ctx-db";
import type { CdcChange } from "../src/ctx-db-cdc";
import type { ReplicaFollowerHost, ReplicaOwnerHost } from "../src/replica";
import { createReplicaLink, gateReplicaDispatch, handleReplicaControl } from "../src/replica";
import createSqliteExec from "./_helpers/node-sqlite";

/**
 * Region-local read replicas: the follow loop, the freshness contract, and
 * every condition under which a replica must refuse to answer.
 *
 * The replica's own follow-position row is exercised against a real SQLite
 * build (see `_helpers/node-sqlite.ts`) so the upsert and the survival of the
 * cursor across calls behave the way they will inside a Durable Object; the
 * owner is a scripted double, because what is under test here is the follower's
 * decisions, not the changelog it reads.
 */

/** An owner double: a changelog it serves, an epoch, a floor, and a snapshot, all settable by the test. */
interface Owner {
    changes: CdcChange[];
    /** The OWNER's env — where the bootstrap cap is read, since the owner decides what it will serve. */
    env: Record<string, unknown>;
    /** `undefined` models a shard with CDC off — the DEFAULT — which has no changelog at all. */
    epoch: string | undefined;
    /** `undefined` models an empty log; a number models a log compacted up to it. */
    floor: number | undefined;
    pulls: number;
    /** Models `runShardCdcSync` refusing a compacted page: the owner throws instead of returning one. */
    readThrows?: boolean;
    /** The owner half of the control channel, reached with the follower's real body and headers. */
    serve: (body: string, headers: HeadersInit | undefined) => Promise<Response>;
    snapshot: ExportRow[];
    snapshots: number;
}

const createOwner = (): Owner => {
    const owner: Owner = {
        changes: [],
        env: { LUNORA_RELAY_SECRET: "s3cret" },
        epoch: "epoch-1",
        floor: undefined,
        pulls: 0,
        snapshot: [],
        snapshots: 0,
        serve: async (body: string, headers: HeadersInit | undefined): Promise<Response> => {
            const host: ReplicaOwnerHost = {
                doName: () => "tenant-7",
                env: () => owner.env,
                exportRows: async () => {
                    owner.snapshots += 1;

                    return owner.snapshot;
                },
                ownerCursor: () => owner.changes.at(-1)?.seq ?? 0,
                ownerEpoch: () => owner.epoch,
                ownerFloor: () => owner.floor,
                readChanges: (sinceSeq: number, limit: number) => {
                    owner.pulls += 1;

                    if (owner.readThrows) {
                        throw new Error("cdc payloads compacted");
                    }

                    const page = owner.changes.filter((change) => change.seq > sinceSeq).slice(0, limit);

                    return { changes: page, cursor: page.at(-1)?.seq ?? sinceSeq };
                },
                rowCount: () => owner.snapshot.length,
                shardBinding: () => "SHARD",
                sql: () => ({}) as SqlExec,
            };

            // The follower's bytes and headers verbatim: the control channel
            // authenticates the exact body it received, so a harness that
            // re-serialized the frame or dropped the signature would be testing
            // a request no replica ever sends.
            return handleReplicaControl(host, new Request("https://replica.internal/_lunora/replica", { body, headers, method: "POST" }));
        },
    };

    return owner;
};

const change = (seq: number, id: string): CdcChange => {
    return { doc: { _id: id, title: `row-${String(seq)}` }, id, op: "insert", seq, table: "posts", ts: seq };
};

const replicaRead = (headers: Record<string, string> = {}): Request =>
    new Request("https://shard.internal/rpc", { headers: { "x-lunora-replica-read": "1", ...headers }, method: "POST" });

describe("read replicas", () => {
    let harness: ReturnType<typeof createSqliteExec>;
    let sql: SqlExec;
    let owner: Owner;
    let applied: CdcChange[];
    let imported: ExportRow[];
    let importErrors: unknown[];
    let env: Record<string, unknown>;
    let host: ReplicaFollowerHost;

    beforeEach(() => {
        harness = createSqliteExec();
        sql = harness.sql;
        owner = createOwner();
        applied = [];
        imported = [];
        importErrors = [];

        // The follow loop addresses its owner through `env[binding]`, which is
        // exactly the seam a test can stand in for: this namespace routes every
        // sibling hop into the owner double.
        const toOwner = { fetch: async (_url: string, init?: RequestInit) => owner.serve(typeof init?.body === "string" ? init.body : "{}", init?.headers) };

        env = { LUNORA_RELAY_SECRET: "s3cret", SHARD: { get: () => toOwner, getByName: () => toOwner, idFromName: (name: string) => name } };

        host = {
            applyChanges: async (changes: ReadonlyArray<CdcChange>) => {
                applied.push(...changes);

                return changes.length;
            },
            doName: () => "tenant-7::replica::weur",
            env: () => env,
            importRows: async (rows: ReadonlyArray<ExportRow>) => {
                imported.push(...rows);

                return { errors: importErrors };
            },
            shardBinding: () => "SHARD",
            sql: () => sql,
        };
    });

    afterEach(() => {
        harness.close();
        vi.useRealTimers();
    });

    it("is built only for a replica-named DO", () => {
        expect.assertions(3);

        const replica = createReplicaLink(host);

        expect(replica?.ownerKey).toBe("tenant-7");
        expect(replica?.region).toBe("weur");
        // An owner name and an unnamed single-DO shard both get no collaborator.
        expect(createReplicaLink({ ...host, doName: () => "tenant-7" })).toBeUndefined();
    });

    it("bootstraps from the owner's snapshot on first use, then serves the read", async () => {
        expect.assertions(4);

        owner.snapshot = [{ doc: { _id: "a", title: "first" }, table: "posts" }];
        owner.changes = [change(4, "a")];

        const replica = createReplicaLink(host);

        // The end-to-end success path: the gate lets a caught-up replica through.
        await expect(gateReplicaDispatch(replica!, replicaRead(), "posts:list")).resolves.toBeUndefined();
        expect(imported).toStrictEqual(owner.snapshot);
        // The snapshot's cursor is the owner's high-watermark at the time it was
        // taken, so the follow loop resumes from there rather than replaying the
        // whole log it already contains.
        expect(replica?.appliedSeq()).toBe(4);
        expect(replica?.isDivergent()).toBe(false);
    });

    it("applies the changelog past its cursor and remembers where it got to", async () => {
        expect.assertions(3);

        const replica = createReplicaLink(host);

        await replica?.ensureFresh();

        owner.changes = [change(1, "a"), change(2, "b")];

        await expect(replica?.ensureFresh(2)).resolves.toBe("fresh");
        expect(applied.map((entry) => entry.seq)).toStrictEqual([1, 2]);
        expect(replica?.appliedSeq()).toBe(2);
    });

    it("carries wire-typed leaves across the control channel intact", async () => {
        expect.assertions(4);

        // `decodeDocJson` hands the owner REAL `bigint` / `ArrayBuffer` / `Date`
        // values, so both directions of this channel have to run the codec: an
        // unencoded `bigint` throws inside `Response.json`, which the follower
        // reads as "owner unreachable" and retries forever, and unencoded bytes
        // flatten to `{}` for the follower to write into its copy of the shard.
        owner.snapshot = [{ doc: { _id: "a", blob: new Uint8Array([1, 2, 3]).buffer, views: 7n }, table: "posts" }];

        const replica = createReplicaLink(host);

        // The snapshot crosses on the bootstrap frame…
        await replica?.ensureFresh();

        expect(imported[0]?.doc).toStrictEqual({ _id: "a", blob: new Uint8Array([1, 2, 3]).buffer, views: 7n });

        // …and a later write crosses on a pull frame. `9007199254740993` is past
        // `Number.MAX_SAFE_INTEGER`, so a codec that round-tripped it through a
        // JSON number would come back off by one rather than merely mistyped.
        owner.changes = [
            {
                doc: { _id: "b", at: new Date("2024-01-01T00:00:00.000Z"), views: 9_007_199_254_740_993n },
                id: "b",
                op: "insert",
                seq: 1,
                table: "posts",
                ts: 1,
            },
        ];

        await expect(replica?.ensureFresh(1)).resolves.toBe("fresh");
        expect(applied[0]?.doc).toStrictEqual({ _id: "b", at: new Date("2024-01-01T00:00:00.000Z"), views: 9_007_199_254_740_993n });
        expect(replica?.appliedSeq()).toBe(1);
    });

    it("serves inside the staleness window without touching the owner", async () => {
        expect.assertions(2);

        const replica = createReplicaLink(host);

        await replica?.ensureFresh();

        owner.changes = [change(1, "a")];
        const before = owner.pulls;

        // No cursor requirement and a just-synced replica: the read is answered
        // locally, which is the entire point of the tier.
        await expect(replica?.ensureFresh()).resolves.toBe("fresh");
        expect(owner.pulls).toBe(before);
    });

    it("catches up past the staleness window even with no cursor requirement", async () => {
        expect.assertions(1);

        vi.useFakeTimers();

        const replica = createReplicaLink(host);

        await replica?.ensureFresh();

        owner.changes = [change(1, "a")];
        vi.advanceTimersByTime(5000);

        await replica?.ensureFresh();

        expect(applied.map((entry) => entry.seq)).toStrictEqual([1]);
    });

    it("refuses to follow a shard that has no changelog", async () => {
        expect.assertions(3);

        // CDC is opt-in, so this is the DEFAULT shape of a shard. Coercing the
        // absent epoch to a sentinel would let the replica bootstrap once, agree
        // with every later empty page that it is caught up, and serve that first
        // snapshot for the life of the DO.
        owner.epoch = undefined;
        owner.snapshot = [{ doc: { _id: "a" }, table: "posts" }];

        const replica = createReplicaLink(host);

        await expect(replica?.ensureFresh()).resolves.toBe("unavailable");
        expect(imported).toStrictEqual([]);
        expect(replica?.isDivergent()).toBe(false);
    });

    it("reports unavailable when the owner's timeline has forked", async () => {
        expect.assertions(3);

        const replica = createReplicaLink(host);

        await replica?.ensureFresh();

        // A reset / point-in-time rollback on the owner mints a new epoch. Its
        // `seq` numbers restart low, so replaying its log onto our rows would
        // fabricate a state neither side ever held.
        owner.epoch = "epoch-2";
        owner.changes = [change(1, "z")];

        await expect(replica?.ensureFresh(1)).resolves.toBe("unavailable");
        expect(applied).toStrictEqual([]);
        // Sticky: re-checking on every read would re-pay the round trip to learn
        // the same answer.
        expect(replica?.isDivergent()).toBe(true);
    });

    it("reports unavailable when the log was compacted past its position", async () => {
        expect.assertions(2);

        const replica = createReplicaLink(host);

        await replica?.ensureFresh();

        owner.changes = [change(9, "i")];
        owner.floor = 9;

        await expect(replica?.ensureFresh(9)).resolves.toBe("unavailable");
        expect(applied).toStrictEqual([]);
    });

    it("bootstraps instead of retrying when the owner's payloads were compacted past it", async () => {
        expect.assertions(3);

        const replica = createReplicaLink(host);

        await replica?.ensureFresh();

        // Payload compaction keeps the KEYS, so the owner's `readChanges` would
        // refuse the page outright rather than return one. A refusal reaching the
        // follower as a bare non-2xx is indistinguishable from an unreachable
        // owner, so it would retry the identical doomed round trip forever and
        // never bootstrap. The floor is checked before the page is read, so the
        // follower is told where it stands.
        owner.changes = [change(9, "i")];
        owner.floor = 9;
        owner.readThrows = true;

        await expect(replica?.ensureFresh(9)).resolves.toBe("unavailable");

        // Latched divergent — which is what routes the next read to a bootstrap
        // rather than to another pull.
        expect(replica?.isDivergent()).toBe(true);
        // And the doomed page was never read.
        expect(owner.pulls).toBe(1);
    });

    it("reports unavailable when the log was compacted away entirely", async () => {
        expect.assertions(1);

        const replica = createReplicaLink(host);

        await replica?.ensureFresh();

        // An emptied log reports no floor at all, but its high-watermark is still
        // ahead of us — writes happened and were compacted before we saw them.
        owner.changes = [];
        owner.floor = undefined;
        (owner as { serve: Owner["serve"] }).serve = async () => Response.json({ changes: [], cursor: 100, epoch: "epoch-1" });

        await expect(replica?.ensureFresh(100)).resolves.toBe("unavailable");
    });

    it("refuses a snapshot whose rows did not all land", async () => {
        expect.assertions(2);

        // The import surfaces per-row failures rather than aborting, so an
        // incomplete snapshot would otherwise be recorded as a complete one.
        importErrors = [{ line: 2, message: "validation failed" }];
        owner.snapshot = [{ doc: { _id: "a" }, table: "posts" }];

        const replica = createReplicaLink(host);

        await expect(replica?.ensureFresh()).resolves.toBe("unavailable");
        expect(replica?.isDivergent()).toBe(true);
    });

    it("collapses concurrent first reads onto one bootstrap", async () => {
        expect.assertions(2);

        owner.snapshot = [{ doc: { _id: "a" }, table: "posts" }];

        const replica = createReplicaLink(host);
        const readiness = await Promise.all([replica?.ensureFresh(), replica?.ensureFresh(), replica?.ensureFresh()]);

        // A DO's input gate does not hold requests across an await, so without
        // the single-flight latch each caller would make the owner export the
        // whole shard again.
        expect(owner.snapshots).toBe(1);
        expect(readiness).toStrictEqual(["fresh", "fresh", "fresh"]);
    });

    it("stops pulling as soon as the owner has nothing more", async () => {
        expect.assertions(2);

        const replica = createReplicaLink(host);

        await replica?.ensureFresh();

        const before = owner.pulls;

        // An unreachable cursor — a stale bookmark, or one a caller supplied —
        // must not turn a single read into ten sequential cross-region pulls.
        await expect(replica?.ensureFresh(999_999)).resolves.toBe("stale");
        expect(owner.pulls - before).toBe(1);
    });

    it("reports unavailable when the owner cannot be reached", async () => {
        expect.assertions(1);

        const unreachable: ReplicaFollowerHost = {
            ...host,
            env: () => {
                return {
                    SHARD: {
                        get: () => {
                            return {
                                fetch: async () => {
                                    throw new Error("no route to owner");
                                },
                            };
                        },
                        idFromName: (name: string) => name,
                    },
                };
            },
        };

        // Nothing bootstrapped means no rows at all, so there is nothing here to
        // answer a read from — the caller must go to the owner.
        await expect(createReplicaLink(unreachable)?.ensureFresh()).resolves.toBe("unavailable");
    });

    it("refuses to serve the control channel from a replica", async () => {
        expect.assertions(1);

        // A replica's local `seq` numbers are its own; answering a pull would
        // hand a follower cursors that mean nothing on the owner's log.
        const response = await handleReplicaControl(
            {
                ...host,
                exportRows: async () => [],
                ownerCursor: () => 0,
                ownerEpoch: () => "e",
                ownerFloor: () => undefined,
                readChanges: () => {
                    return { changes: [], cursor: 0 };
                },
                rowCount: () => 0,
            },
            new Request("https://replica.internal/_lunora/replica", { body: JSON.stringify({ sinceSeq: 0, type: "replica_pull" }), method: "POST" }),
        );

        expect(response.status).toBe(409);
    });

    it("refuses to replicate at all when no control-channel secret is configured", async () => {
        expect.assertions(2);

        // The relay channel tolerates a missing secret for back-compat; this one
        // hands back every row of the shard, and the feature is new, so an
        // unconfigured deployment gets no replication rather than an
        // unauthenticated snapshot endpoint.
        owner.env = {};

        const replica = createReplicaLink(host);

        await expect(replica?.ensureFresh()).resolves.toBe("unavailable");
        expect(imported).toStrictEqual([]);
    });

    it("refuses a snapshot larger than the cap without building it", async () => {
        expect.assertions(2);

        owner.env["LUNORA_REPLICA_MAX_BOOTSTRAP_ROWS"] = "1";
        owner.snapshot = [
            { doc: { _id: "a" }, table: "posts" },
            { doc: { _id: "b" }, table: "posts" },
        ];

        const replica = createReplicaLink(host);

        await expect(replica?.ensureFresh()).resolves.toBe("unavailable");
        // The cap protects the OWNER's memory budget, so it has to be decided
        // from a row count — materializing the snapshot first and measuring it
        // afterwards would have already spent what the cap exists to save.
        expect(owner.snapshots).toBe(0);
    });

    it("rejects an unsigned frame when a control-channel secret is configured", async () => {
        expect.assertions(1);

        const ownerHost: ReplicaOwnerHost = {
            doName: () => "tenant-7",
            env: () => {
                return { LUNORA_RELAY_SECRET: "s3cret" };
            },
            exportRows: async () => [],
            ownerCursor: () => 0,
            ownerEpoch: () => "epoch-1",
            ownerFloor: () => undefined,
            readChanges: () => {
                return { changes: [], cursor: 0 };
            },
            rowCount: () => 0,
            shardBinding: () => "SHARD",
            sql: () => sql,
        };

        const response = await handleReplicaControl(
            ownerHost,
            new Request("https://replica.internal/_lunora/replica", { body: JSON.stringify({ sinceSeq: 0, type: "replica_pull" }), method: "POST" }),
        );

        expect(response.status).toBe(403);
    });
});

describe("replica dispatch gate", () => {
    let harness: ReturnType<typeof createSqliteExec>;

    beforeEach(() => {
        harness = createSqliteExec();
    });

    afterEach(() => {
        harness.close();
    });

    const followerHost = (): ReplicaFollowerHost => {
        return {
            applyChanges: async () => 0,
            doName: () => "tenant-7::replica::weur",
            env: () => {
                return {};
            },
            importRows: async () => {
                return { errors: [] };
            },
            shardBinding: () => undefined,
            sql: () => harness.sql,
        };
    };

    it("refuses any dispatch the runtime did not mark as a replica read", async () => {
        expect.assertions(2);

        const replica = createReplicaLink(followerHost());
        const response = await gateReplicaDispatch(replica!, new Request("https://shard.internal/rpc", { method: "POST" }), "posts:add");
        const body: { error: { code: string } } = await response!.json();

        expect(response?.status).toBe(421);
        expect(body.error.code).toBe("REPLICA_READ_ONLY");
    });

    it("reports the fallback reason when it cannot serve the read", async () => {
        expect.assertions(2);

        // No shard binding, so the follow loop cannot address its owner and the
        // replica has nothing bootstrapped to answer from.
        const replica = createReplicaLink(followerHost());
        const response = await gateReplicaDispatch(replica!, replicaRead(), "posts:list");

        expect(response?.status).toBe(421);
        expect(response?.headers.get("x-lunora-replica-fallback")).toBe("unavailable");
    });
});
