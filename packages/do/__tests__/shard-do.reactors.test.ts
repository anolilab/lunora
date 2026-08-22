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
        expect.assertions(3);

        const shard = new ReactorShard(createState(), {});

        await shard.writeRpc();

        expect(shard.runs).toHaveLength(1);
        // No baseline on the first run: "unknown" reads as "changed", never as
        // "unchanged" — the degradation direction the whole feature follows.
        expect(shard.runs[0]?.previousDigest).toBeUndefined();
        expect(readReactorState(harness.sql, "reactors:dispatch")).toStrictEqual({ digest: "stable", tables: ["orders"] });
    });

    it("offers the stored baseline back on the next flush", async () => {
        expect.assertions(2);

        const shard = new ReactorShard(createState(), {});

        await shard.writeRpc();
        await shard.writeRpc();

        expect(shard.runs).toHaveLength(2);
        // The digest is what lets the dispatch suppress the app handler when the
        // result did not actually move — the trigger/reactor distinction.
        expect(shard.runs[1]?.previousDigest).toBe("stable");
    });

    it("skips the reactor entirely when the flush touched nothing it read", async () => {
        expect.assertions(2);

        const shard = new ReactorShard(createState(), {});

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

        const shard = new ReactorShard(createState(), {});

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
        expect.assertions(3);

        const shard = new ReactorShard(createState(), {});

        shard.throwOnRun = true;

        await expect(shard.writeRpc()).resolves.toBeDefined();

        // Not advanced: a reactor that threw never observed this result, so the
        // next flush has to offer it again rather than skipping it forever.
        expect(readReactorState(harness.sql, "reactors:dispatch")).toBeUndefined();
        expect(shard.errors).toStrictEqual(["reactors:dispatch"]);
    });

    it("keeps reactors independent — one failing does not skip the rest", async () => {
        expect.assertions(2);

        const shard = new ReactorShard(createState(), {});

        shard.reactorPaths = ["reactors:a", "reactors:b"];

        await shard.writeRpc();

        expect(shard.runs.map((run) => run.path)).toStrictEqual(["reactors:a", "reactors:b"]);
        expect(readReactorState(harness.sql, "reactors:b")?.digest).toBe("stable");
    });

    it("does nothing at all when no reactor is declared", async () => {
        expect.assertions(1);

        const shard = new ReactorShard(createState(), {});

        shard.reactorPaths = [];

        await shard.writeRpc();

        expect(shard.runs).toHaveLength(0);
    });
});
