import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ExportRow } from "../src/admin-export-import";
import type { SqlExec } from "../src/ctx-db";
import type { CdcChange } from "../src/ctx-db-cdc";
import type { ReplicaFollowerHost, ReplicaOwnerHost } from "../src/replica";
import { createReplicaLink, gateReplicaDispatch, handleReplicaControl } from "../src/replica";
import type { TransactionLimits } from "../src/transaction-headroom";
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

                    // Refuses only a cursor below the retained floor, like the real reader; with no floor it refuses outright.
                    if (owner.readThrows && (owner.floor === undefined || owner.floor > sinceSeq + 1)) {
                        throw new Error("cdc payloads compacted");
                    }

                    const page = owner.changes.filter((change) => change.seq > sinceSeq).slice(0, limit);

                    return { changes: page, cursor: page.at(-1)?.seq ?? sinceSeq };
                },
                rowCount: () => owner.snapshot.length,
                shardBinding: () => "SHARD",
                shardJurisdiction: () => undefined,
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
    let localRows: ExportRow[];
    let env: Record<string, unknown>;
    let host: ReplicaFollowerHost;

    beforeEach(() => {
        harness = createSqliteExec();
        sql = harness.sql;
        owner = createOwner();
        applied = [];
        imported = [];
        importErrors = [];
        localRows = [];

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
            exportRows: async () => localRows,
            importRows: async (rows: ReadonlyArray<ExportRow>) => {
                imported.push(...rows);

                return { errors: importErrors };
            },
            shardBinding: () => "SHARD",
            shardJurisdiction: () => undefined,
            sql: () => sql,
            transactionLimits: () => {
                return {};
            },
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

    it("addresses its owner through its OWN jurisdiction subnamespace, not the raw binding", async () => {
        expect.assertions(3);

        owner.snapshot = [{ doc: { _id: "a", title: "first" }, table: "posts" }];
        owner.changes = [change(4, "a")];

        // Cloudflare mints a DIFFERENT `DurableObjectId` for the same name inside
        // a jurisdiction subnamespace (`ns.idFromName(n) !== ns.jurisdiction("eu")
        // .idFromName(n)`), and the worker stamps the RAW env key as
        // `x-lunora-shard-binding` while routing its own traffic through the
        // pinned namespace. Resolving off that raw binding therefore woke a
        // stranger DO — empty, and outside the declared residency.
        let phantomHits = 0;
        const phantom = {
            fetch: async () => {
                phantomHits += 1;

                return new Response("shard has no changelog to replicate", { status: 409 });
            },
        };
        const toOwner = { fetch: async (_url: string, init?: RequestInit) => owner.serve(typeof init?.body === "string" ? init.body : "{}", init?.headers) };
        const pinned = { get: () => toOwner, getByName: () => toOwner, idFromName: (name: string) => name };

        env["SHARD"] = {
            get: () => phantom,
            getByName: () => phantom,
            idFromName: (name: string) => name,
            jurisdiction: (jurisdiction: string) =>
                jurisdiction === "eu" ? pinned : { get: () => phantom, getByName: () => phantom, idFromName: (name: string) => name },
        };

        const replica = createReplicaLink({ ...host, shardJurisdiction: () => "eu" });

        await expect(gateReplicaDispatch(replica!, replicaRead(), "posts:list")).resolves.toBeUndefined();
        expect(imported).toStrictEqual(owner.snapshot);
        expect(phantomHits).toBe(0);
    });

    it("stays inert rather than reaching an unpinned sibling when the binding cannot express its jurisdiction", async () => {
        expect.assertions(1);

        owner.snapshot = [{ doc: { _id: "a", title: "first" }, table: "posts" }];
        owner.changes = [change(4, "a")];

        // The harness namespace has no `jurisdiction()`. Falling back to it would
        // open a stub outside the compliance boundary the app declared, so the
        // tier goes inert and the read falls back to the worker-routed owner —
        // which IS pinned.
        await expect(createReplicaLink({ ...host, shardJurisdiction: () => "eu" })?.ensureFresh()).resolves.toBe("unavailable");
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

    it("latches divergence instead of rejecting when a page cannot be applied", async () => {
        expect.assertions(6);

        const reported: unknown[] = [];
        const replica = createReplicaLink({
            ...host,
            applyChanges: async () => {
                throw new Error("poison change");
            },
            reportError: (_scope: string, error: unknown) => {
                reported.push(error);
            },
        });

        await replica?.ensureFresh();

        owner.changes = [change(1, "a")];

        // A page that throws on apply must not reject the read: the owner can answer it.
        await expect(replica?.ensureFresh(1)).resolves.toBe("unavailable");

        const pullsAfterFailure = owner.pulls;

        // Sticky: the same doomed page is not re-pulled and re-applied on every read.
        await expect(replica?.ensureFresh(1)).resolves.toBe("unavailable");
        expect(owner.pulls).toBe(pullsAfterFailure);
        expect(replica?.isDivergent()).toBe(true);
        expect(reported).toHaveLength(1);
        // The cursor never moved past the page that did not apply.
        expect(replica?.appliedSeq()).toBe(0);
    });

    it("retries on the next sync instead of latching when the failure is flagged transient", async () => {
        expect.assertions(6);

        let failures = 1;
        const reported: unknown[] = [];
        const replica = createReplicaLink({
            ...host,
            applyChanges: async (changes: ReadonlyArray<CdcChange>) => {
                if (failures > 0) {
                    failures -= 1;

                    throw Object.assign(new Error("storage hiccup"), { retryable: true });
                }

                applied.push(...changes);

                return changes.length;
            },
            reportError: (_scope: string, error: unknown) => {
                reported.push(error);
            },
        });

        await replica?.ensureFresh();

        owner.changes = [change(1, "a")];

        await expect(replica?.ensureFresh(1)).resolves.toBe("unavailable");
        expect(replica?.isDivergent()).toBe(false);
        expect(replica?.appliedSeq()).toBe(0);
        expect(reported).toHaveLength(1);

        // The same page is pulled and applied on the next read.
        await expect(replica?.ensureFresh(1)).resolves.toBe("fresh");
        expect(replica?.appliedSeq()).toBe(1);
    });

    it("answers 421 rather than throwing from the dispatch gate when a page cannot be applied", async () => {
        expect.assertions(2);

        const replica = createReplicaLink({
            ...host,
            applyChanges: async () => {
                throw new Error("poison change");
            },
        });

        await replica?.ensureFresh();

        owner.changes = [change(1, "a")];

        const response = await gateReplicaDispatch(replica!, replicaRead({ "x-lunora-min-seq": "1" }), "posts:list");

        expect(response?.status).toBe(421);
        expect(response?.headers.get("x-lunora-replica-fallback")).toBe("unavailable");
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

    it("is not fresh after one page of a multi-page backlog: it pages until the log is drained", async () => {
        expect.assertions(2);

        vi.useFakeTimers();

        const replica = createReplicaLink(host);

        await replica?.ensureFresh();

        // Idle while the owner took 2,500 writes: three pages, the last one short.
        owner.changes = Array.from({ length: 2500 }, (_, index) => change(index + 1, `r${String(index + 1)}`));
        vi.advanceTimersByTime(60_000);

        await expect(replica?.ensureFresh()).resolves.toBe("fresh");
        expect(applied.at(-1)?.seq).toBe(2500);
    });

    it("reports stale, not fresh, when the backlog outlasts the pull budget", async () => {
        expect.assertions(2);

        vi.useFakeTimers();

        const replica = createReplicaLink(host);

        await replica?.ensureFresh();

        // Ten full pages (the budget) and more behind them: the replica never
        // saw the end of the log, so the staleness window cannot vouch for it
        // and the read goes to the owner.
        owner.changes = Array.from({ length: 10_500 }, (_, index) => change(index + 1, `r${String(index + 1)}`));
        vi.advanceTimersByTime(60_000);

        await expect(replica?.ensureFresh()).resolves.toBe("stale");
        expect(applied.at(-1)?.seq).toBe(10_000);
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

    it("bootstraps when the owner's log rewound beneath it on the SAME epoch", async () => {
        expect.assertions(4);

        const replica = createReplicaLink(host);

        owner.changes = [change(1, "a"), change(2, "b"), change(3, "c")];

        await replica?.ensureFresh(3);

        // A NATIVE point-in-time restore is the case the epoch cannot report: it
        // reverts the owner's whole SQLite database, the `__cdc_meta` row that
        // holds the epoch included, so the timeline forks and the epoch comes
        // back identical. The follower's own applied position is then the only
        // surviving record of the pre-restore timeline — and a high-watermark
        // BELOW it is proof the owner can no longer account for rows the
        // follower has already replayed.
        owner.changes = [change(1, "z")];
        // The owner's changelog read refuses such a cursor outright; the pull
        // must answer with its rewound high-watermark before reaching it, since a
        // thrown response reads here as "owner unreachable" and would be retried
        // forever instead of bootstrapping.
        owner.readThrows = true;

        const pullsBefore = owner.pulls;

        await expect(replica?.ensureFresh(4)).resolves.toBe("unavailable");
        expect(replica?.isDivergent()).toBe(true);
        // Nothing from the second timeline was replayed over the snapshot the
        // first one produced, which is the corruption this refusal prevents.
        expect(applied).toStrictEqual([]);
        expect(owner.pulls).toBe(pullsBefore);
    });

    it("re-snapshots instead of falling back to the owner when the log was compacted past its position", async () => {
        expect.assertions(4);

        const replica = createReplicaLink(host);

        await replica?.ensureFresh();

        owner.changes = [change(9, "i")];
        owner.floor = 9;

        await expect(replica?.ensureFresh(9)).resolves.toBe("fresh");
        expect(replica?.isDivergent()).toBe(false);
        expect(replica?.appliedSeq()).toBe(9);
        expect(owner.snapshots).toBe(2);
    });

    it("converges on the snapshot: upserts what changed, deletes what the owner no longer has", async () => {
        expect.assertions(5);

        const replica = createReplicaLink(host);

        await replica?.ensureFresh();

        // The replica holds `a` (old version) and `b`; in the gap the owner updated `a`, deleted `b` and added `c`.
        localRows = [
            { doc: { _id: "a", title: "v1" }, table: "posts" },
            { doc: { _id: "b", title: "gone" }, table: "posts" },
        ];
        owner.snapshot = [
            { doc: { _id: "a", title: "v2" }, table: "posts" },
            { doc: { _id: "c", title: "new" }, table: "posts" },
        ];
        owner.changes = [change(9, "c")];
        owner.floor = 9;

        await expect(replica?.ensureFresh(9)).resolves.toBe("fresh");
        expect(
            applied.map(({ doc, id, op, table }) => {
                return { doc, id, op, table };
            }),
        ).toStrictEqual([
            { doc: { _id: "a", title: "v2" }, id: "a", op: "insert", table: "posts" },
            { doc: { _id: "c", title: "new" }, id: "c", op: "insert", table: "posts" },
            { doc: undefined, id: "b", op: "delete", table: "posts" },
        ]);
        expect(replica?.appliedSeq()).toBe(9);
        expect(replica?.isDivergent()).toBe(false);
        // The snapshot goes through the writer, never the append-only import that would keep `a`'s old version.
        expect(imported).toStrictEqual([]);
    });

    describe("a re-snapshot against the transaction write ceilings", () => {
        /** A replica that already follows its owner, then finds the owner's log compacted past it with `snapshot` to take. */
        const compactedPast = async (limits: Partial<TransactionLimits>, snapshot: ExportRow[]) => {
            const reported: unknown[] = [];
            const exported = { count: 0 };
            const replica = createReplicaLink({
                ...host,
                exportRows: async () => {
                    exported.count += 1;

                    return localRows;
                },
                reportError: (_scope, error) => reported.push(error),
                transactionLimits: () => limits,
            });

            await replica?.ensureFresh();

            applied.length = 0;
            localRows = [{ doc: { _id: "stale", title: "gone" }, table: "posts" }];
            owner.snapshot = snapshot;
            owner.changes = [change(9, "a")];
            owner.floor = 9;

            return { exported, replica, reported };
        };

        const rows = (count: number): ExportRow[] =>
            Array.from({ length: count }, (_, index) => {
                return { doc: { _id: `r${String(index)}`, title: "t" }, table: "posts" };
            });

        it("refuses a snapshot whose rows plus stale deletions exceed the row ceiling, without latching", async () => {
            expect.assertions(6);

            // 3 snapshot rows + 1 stale deletion = 4 writes against a ceiling of 3.
            const { replica, reported } = await compactedPast({ maxWrittenRows: 3 }, rows(3));

            await expect(replica?.ensureFresh(9)).resolves.toBe("unavailable");
            expect(applied).toStrictEqual([]);
            expect(reported).toHaveLength(1);
            expect((reported[0] as { code?: string }).code).toBe("TRANSACTION_LIMIT_EXCEEDED");
            expect(replica?.isDivergent()).toBe(false);
            expect(replica?.appliedSeq()).toBe(0);
        });

        it("refuses a snapshot over the byte ceiling before loading the local rows", async () => {
            expect.assertions(4);

            const { exported, replica } = await compactedPast({ maxWrittenBytes: 50 }, rows(3));

            await expect(replica?.ensureFresh(9)).resolves.toBe("unavailable");
            expect(applied).toStrictEqual([]);
            expect(exported.count).toBe(0);
            expect(replica?.isDivergent()).toBe(false);
        });

        it("converges when the writes land exactly on the ceiling", async () => {
            expect.assertions(3);

            // 2 snapshot rows + 1 stale deletion = 3 writes against a ceiling of 3.
            const { replica, reported } = await compactedPast({ maxWrittenRows: 3 }, rows(2));

            await expect(replica?.ensureFresh(9)).resolves.toBe("fresh");
            expect(applied.map(({ id, op }) => `${op}:${id}`)).toStrictEqual(["insert:r0", "insert:r1", "delete:stale"]);
            expect(reported).toStrictEqual([]);
        });
    });

    it("re-snapshots when the owner's payloads were compacted past it, without reading the doomed page", async () => {
        expect.assertions(4);

        const replica = createReplicaLink(host);

        await replica?.ensureFresh();

        // Payload compaction keeps the KEYS, so the owner's `readChanges` would
        // refuse the page outright rather than return one. A refusal reaching the
        // follower as a bare non-2xx is indistinguishable from an unreachable
        // owner, so it would retry the identical doomed round trip forever. The
        // floor is checked before the page is read, so the follower is told where
        // it stands and takes a snapshot instead.
        owner.changes = [change(9, "i")];
        owner.floor = 9;
        owner.readThrows = true;

        const pullsBefore = owner.pulls;

        await expect(replica?.ensureFresh(9)).resolves.toBe("fresh");
        expect(replica?.isDivergent()).toBe(false);
        expect(replica?.appliedSeq()).toBe(9);
        // The page below the floor was never read: one pull from the new position, nothing before it.
        expect(owner.pulls - pullsBefore).toBe(1);
    });

    it("re-snapshots once per catch-up and reports unavailable, without latching, when the owner keeps trimming past it", async () => {
        expect.assertions(4);

        const replica = createReplicaLink(host);

        await replica?.ensureFresh();

        // A floor far beyond the cursor the snapshot lands on: the position it reaches is already compacted away.
        owner.changes = [change(9, "i")];
        owner.floor = 50;

        await expect(replica?.ensureFresh(9)).resolves.toBe("unavailable");
        expect(owner.snapshots).toBe(2);
        expect(replica?.isDivergent()).toBe(false);

        // Not latched: a later read tries again once the owner's log reaches back.
        owner.floor = 9;

        await expect(replica?.ensureFresh(9)).resolves.toBe("fresh");
    });

    it("latches when the re-snapshot cannot be applied", async () => {
        expect.assertions(3);

        const replica = createReplicaLink({
            ...host,
            applyChanges: async () => {
                throw new Error("poison snapshot row");
            },
        });

        await replica?.ensureFresh();

        owner.snapshot = [{ doc: { _id: "a", title: "v2" }, table: "posts" }];
        owner.changes = [change(9, "a")];
        owner.floor = 9;

        await expect(replica?.ensureFresh(9)).resolves.toBe("unavailable");
        expect(replica?.isDivergent()).toBe(true);
        // The position never moved onto a snapshot that did not land.
        expect(replica?.appliedSeq()).toBe(0);
    });

    it("re-snapshots when the log was compacted away entirely", async () => {
        expect.assertions(3);

        const replica = createReplicaLink(host);

        await replica?.ensureFresh();

        // An emptied log reports no floor at all, but its high-watermark is still
        // ahead of us — writes happened and were compacted before we saw them.
        owner.changes = [];
        owner.floor = undefined;
        (owner as { serve: Owner["serve"] }).serve = async (body: string) => {
            const isBootstrap = (JSON.parse(body) as { type: string }).type === "replica_bootstrap";

            return Response.json(isBootstrap ? { cursor: 100, epoch: "epoch-1", rows: [] } : { changes: [], cursor: 100, epoch: "epoch-1" });
        };

        await expect(replica?.ensureFresh(100)).resolves.toBe("fresh");
        expect(replica?.isDivergent()).toBe(false);
        expect(replica?.appliedSeq()).toBe(100);
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
            shardJurisdiction: () => undefined,
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
            exportRows: async () => [],
            importRows: async () => {
                return { errors: [] };
            },
            shardBinding: () => undefined,
            shardJurisdiction: () => undefined,
            sql: () => harness.sql,
            transactionLimits: () => {
                return {};
            },
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
