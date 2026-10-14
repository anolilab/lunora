import type { ReactorsResult } from "@lunora/shard-engine";
import { migrateReactorState, readReactorState } from "@lunora/shard-engine";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ShardDOState } from "../src/shard-do";
import { ShardDO } from "../src/shard-do";
import createSqliteExec from "./_helpers/node-sqlite";

/**
 * `onQueryChange` dispatch: the three properties that make a reactor different
 * from a trigger, and the one that keeps a bad reactor from taking the shard
 * down with it.
 *
 * 1. The cheap gate — a flush that touched none of the tables a reactor read last
 * time does not even re-run its `select`.
 * 2. The baseline is durable — it rides `__reactor_state`, so an eviction cannot
 * turn an idle wake into a re-fire of every reactor on the shard.
 * 3. A cascade is the feature — a reactor's own writes flush and re-enter the
 * drain, which is how an actor advances a state machine a step at a time.
 * 4. A cascade that never settles is bounded — a handler that always changes its
 * own read is stopped after `MAX_REACTOR_RUNS_PER_DRAIN` within one drain and
 * named, rather than spinning forever.
 *
 * Driven through the real path — `fetch("/rpc")` → `recordChangedTable` →
 * `flushChangedTables` → the refresh drain — against real SQLite, so the
 * baseline round-trips exactly as it does in production. `waitUntil` is omitted
 * from the state so the flush awaits inline and run counts are deterministic.
 */
interface ReactorRun {
    path: string;
    previousDigest: string | undefined;
}

let harness: ReturnType<typeof createSqliteExec>;

class ReactorShard extends ShardDO {
    /** Tables each dispatch reports as its read footprint. */
    public footprint: string[] = ["orders"];

    /** Reactor paths the manifest exposes. */
    public reactorPaths: string[] = ["reactors:dispatch"];

    /** Reactor paths the base reported a contained failure for. */
    public readonly errors: string[] = [];

    public readonly runs: ReactorRun[] = [];

    /** When set, every dispatch throws — for the containment case. */
    public throwOnRun = false;

    /** When true, each dispatch reports a NEW digest and records a write, i.e. never converges. */
    public neverConverges = false;

    /** The table a write RPC reports as changed. */
    public writesTable = "orders";

    private digestCounter = 0;

    public override handleRpc(): Promise<unknown> {
        this.recordChangedTable(this.writesTable);

        return Promise.resolve({ ok: true });
    }

    public writeRpc(): Promise<Response> {
        return this.fetch(
            new Request("https://shard.internal/rpc", {
                body: JSON.stringify({ args: {}, functionPath: "mutation:write" }),
                headers: { "content-type": "application/json" },
                method: "POST",
            }),
        );
    }

    protected override recordReactorError(path: string, error: unknown): void {
        this.errors.push(path);
        super.recordReactorError(path, error);
    }

    protected override lifecycleHookPaths(event: "connect" | "disconnect" | "init" | "reactor"): ReadonlyArray<string> {
        return event === "reactor" ? this.reactorPaths : [];
    }

    protected override async runReactor(
        path: string,
        previousDigest?: string,
    ): Promise<{ digest: string; ran: boolean; tables: ReadonlyArray<string> } | undefined> {
        await Promise.resolve();

        this.runs.push({ path, previousDigest });

        if (this.throwOnRun) {
            throw new Error("reactor blew up");
        }

        if (this.neverConverges) {
            // Stand-in for a handler that rewrites what its own select reads: a
            // fresh digest every time, plus a write that re-enters the drain.
            this.digestCounter += 1;
            this.recordChangedTable(this.writesTable);

            return { digest: `d${String(this.digestCounter)}`, ran: true, tables: this.footprint };
        }

        return { digest: "stable", ran: previousDigest !== "stable", tables: this.footprint };
    }
}

const ADMIN_TOKEN = "s3cret-admin";

/** An authenticated admin-RPC POST — how the studio's Reactors panel reads this shard. */
const adminRequest = (functionPath: string): Request =>
    new Request("https://shard.internal/rpc", {
        body: JSON.stringify({ args: {}, functionPath }),
        headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "content-type": "application/json" },
        method: "POST",
    });

const createState = (): ShardDOState => {
    return {
        acceptWebSocket: () => undefined,
        getWebSockets: () => [],
        id: { name: "shard-a" },
        // The harness `SqlExec` is structurally what the DO uses at runtime; the
        // state type models workerd's wider `SqlStorage` (index signature and all),
        // so the cast bridges the two the way every other DO suite does.
        storage: { sql: harness.sql as unknown as ShardDOState["storage"]["sql"] },
    };
};

describe("shardDO onQueryChange dispatch", () => {
    beforeEach(() => {
        harness = createSqliteExec();
        migrateReactorState(harness.sql);
    });

    afterEach(() => {
        harness.close();
    });

    it("runs a reactor on the first flush and persists its baseline", async () => {
        expect.assertions(4);

        const shard = new ReactorShard(createState(), { LUNORA_ADMIN_TOKEN: ADMIN_TOKEN });

        await shard.writeRpc();

        expect(shard.runs).toHaveLength(1);
        // No baseline on the first run: "unknown" reads as "changed", never as
        // "unchanged" — the degradation direction the whole feature follows.
        expect(shard.runs[0]?.previousDigest).toBeUndefined();

        const stored = readReactorState(harness.sql, "reactors:dispatch");

        expect(stored?.digest).toBe("stable");
        expect(stored?.tables).toStrictEqual(["orders"]);
    });

    it("offers the stored baseline back on the next flush", async () => {
        expect.assertions(2);

        const shard = new ReactorShard(createState(), { LUNORA_ADMIN_TOKEN: ADMIN_TOKEN });

        await shard.writeRpc();
        await shard.writeRpc();

        expect(shard.runs).toHaveLength(2);
        // The digest is what lets the dispatch suppress the app handler when the
        // result did not actually move — the trigger/reactor distinction.
        expect(shard.runs[1]?.previousDigest).toBe("stable");
    });

    it("skips the reactor entirely when the flush touched nothing it read", async () => {
        expect.assertions(2);

        const shard = new ReactorShard(createState(), { LUNORA_ADMIN_TOKEN: ADMIN_TOKEN });

        await shard.writeRpc();

        expect(shard.runs).toHaveLength(1);

        // A write to an unrelated table cannot have changed the watched read, so
        // `select` is not re-run at all — not merely suppressed after running.
        shard.writesTable = "auditLog";
        await shard.writeRpc();

        expect(shard.runs).toHaveLength(1);
    });

    it("bounds a reactor whose handler never stops changing its own read", async () => {
        expect.assertions(3);

        const shard = new ReactorShard(createState(), { LUNORA_ADMIN_TOKEN: ADMIN_TOKEN });

        shard.neverConverges = true;

        await shard.writeRpc();

        // The cascade is real work, not a spin: capped, and capped within ONE
        // drain so ordinary sustained write load is never throttled.
        expect(shard.runs).toHaveLength(8);
        expect(shard.errors).toStrictEqual(["reactors:dispatch"]);
        // Named once per drain, not once per pass — otherwise a non-converging
        // reactor floods the very ring that reports it.
        expect(shard.errors).toHaveLength(1);
    });

    it("contains a throwing reactor and leaves its baseline for a retry", async () => {
        expect.assertions(4);

        const shard = new ReactorShard(createState(), { LUNORA_ADMIN_TOKEN: ADMIN_TOKEN });

        shard.throwOnRun = true;

        await expect(shard.writeRpc()).resolves.toBeDefined();

        // The counters ARE recorded, but the baseline is not: a reactor that threw
        // never observed this result, so the next flush has to offer it again
        // rather than skipping it forever. An empty digest + unknown footprint is
        // exactly what `reactorNeedsRun` reads as "must run".
        const stored = readReactorState(harness.sql, "reactors:dispatch");

        expect(stored?.digest).toBe("");
        expect(stored?.tables).toBeUndefined();
        expect(shard.errors).toStrictEqual(["reactors:dispatch"]);
    });

    it("contains a failure in the bookkeeping write itself", async () => {
        expect.assertions(3);

        const shard = new ReactorShard(createState(), { LUNORA_ADMIN_TOKEN: ADMIN_TOKEN });

        shard.reactorPaths = ["reactors:broken", "reactors:healthy"];
        shard.throwOnRun = true;

        // A reactor that throws because storage is unhealthy is exactly the
        // condition that also breaks the counter write recording the failure.
        // Drop the state table so `writeReactorState` throws inside the `catch`.
        harness.sql.exec("DROP TABLE __reactor_state");

        // The drain must still finish: unguarded, the second throw would escape
        // `dispatchReactors`, abort `drainSubscriptionRefreshes` mid-loop, and
        // strand every table merged into the pending set after it.
        await expect(shard.writeRpc()).resolves.toBeDefined();

        // The reactor's OWN error is still reported — the bookkeeping failure must
        // not swallow the reason it failed.
        expect(shard.errors).toContain("reactors:broken");
        // And the sibling still ran.
        expect(shard.runs.map((run) => run.path)).toStrictEqual(["reactors:broken", "reactors:healthy"]);
    });

    it("keeps reactors independent — one failing does not skip the rest", async () => {
        expect.assertions(2);

        const shard = new ReactorShard(createState(), { LUNORA_ADMIN_TOKEN: ADMIN_TOKEN });

        shard.reactorPaths = ["reactors:a", "reactors:b"];

        await shard.writeRpc();

        expect(shard.runs.map((run) => run.path)).toStrictEqual(["reactors:a", "reactors:b"]);
        expect(readReactorState(harness.sql, "reactors:b")?.digest).toBe("stable");
    });

    it("does nothing at all when no reactor is declared", async () => {
        expect.assertions(1);

        const shard = new ReactorShard(createState(), { LUNORA_ADMIN_TOKEN: ADMIN_TOKEN });

        shard.reactorPaths = [];

        await shard.writeRpc();

        expect(shard.runs).toHaveLength(0);
    });

    /**
     * `__lunora_admin__:listReactors` — what the studio's Reactors panel reads.
     *
     * The join is the point: the manifest is the roster (so a declared-but-never-
     * dispatched reactor still appears, which is the state an operator is looking
     * for when a reactor seems not to work), and `__reactor_state` supplies the
     * counters (durable, so they survive the hibernation that is a reactor's
     * normal steady state).
     */
    describe("listReactors admin read", () => {
        // Admin responses are wire-encoded under `result` (see `adminResponse`),
        // so the panel's payload is one level in.
        const read = async (shard: ReactorShard): Promise<ReactorsResult> => {
            const response = await shard.fetch(adminRequest("__lunora_admin__:listReactors"));
            const body: unknown = await response.json();

            return (body as { result: ReactorsResult }).result;
        };

        it("reports a declared but never-dispatched reactor as idle", async () => {
            expect.assertions(2);

            const shard = new ReactorShard(createState(), { LUNORA_ADMIN_TOKEN: ADMIN_TOKEN });

            const { reactors } = await read(shard);

            // Zero counters and no `lastRanAt`: materially different from a reactor
            // that runs and is quiet, which the state table alone could not express.
            expect(reactors).toHaveLength(1);
            expect(reactors[0]).toStrictEqual({ errors: 0, path: "reactors:dispatch", runs: 0, state: "idle", suppressed: 0 });
        });

        it("counts a run and records the learned footprint", async () => {
            expect.assertions(4);

            const shard = new ReactorShard(createState(), { LUNORA_ADMIN_TOKEN: ADMIN_TOKEN });

            await shard.writeRpc();

            const { reactors } = await read(shard);
            const [reactor] = reactors;

            expect(reactor?.state).toBe("active");
            expect(reactor?.runs).toBe(1);
            expect(reactor?.tables).toStrictEqual(["orders"]);
            expect(reactor?.lastRanAt).toBeGreaterThan(0);
        });

        it("separates a suppressed dispatch from a run", async () => {
            expect.assertions(2);

            const shard = new ReactorShard(createState(), { LUNORA_ADMIN_TOKEN: ADMIN_TOKEN });

            // First flush runs (no baseline); the second re-runs `select`, matches
            // the digest, and suppresses the handler.
            await shard.writeRpc();
            await shard.writeRpc();

            const { reactors } = await read(shard);
            const [reactor] = reactors;

            expect(reactor?.runs).toBe(1);
            expect(reactor?.suppressed).toBe(1);
        });

        it("surfaces a failing reactor with its message", async () => {
            expect.assertions(3);

            const shard = new ReactorShard(createState(), { LUNORA_ADMIN_TOKEN: ADMIN_TOKEN });

            shard.throwOnRun = true;
            await shard.writeRpc();

            const { reactors } = await read(shard);
            const [reactor] = reactors;

            expect(reactor?.state).toBe("failing");
            expect(reactor?.errors).toBe(1);
            expect(reactor?.lastError).toBe("reactor blew up");
        });

        it("returns an empty roster when nothing is declared", async () => {
            expect.assertions(1);

            const shard = new ReactorShard(createState(), { LUNORA_ADMIN_TOKEN: ADMIN_TOKEN });

            shard.reactorPaths = [];

            const { reactors } = await read(shard);

            expect(reactors).toStrictEqual([]);
        });
    });
});
