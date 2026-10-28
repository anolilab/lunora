import type { SchemaLike } from "@lunora/shard-engine";
import { runShardMigrations } from "@lunora/shard-engine";
import { describe, expect, it } from "vitest";

import type { ShardDOState } from "../src/shard-do";
import { ShardDO } from "../src/shard-do";
import watchPendingWork from "../src/unawaited-work";
import createSqliteExec from "./_helpers/node-sqlite";

/** A promise the test settles by hand, so "still pending" is a state, not a timing. */
const deferred = (): { promise: Promise<string>; resolve: () => void } => {
    let settle!: () => void;
    const promise = new Promise<string>((resolve) => {
        settle = () => {
            resolve("ok");
        };
    });

    return { promise, resolve: settle };
};

class Bucket {
    readonly #written: string[] = [];

    public async put(key: string): Promise<void> {
        this.#written.push(key);
    }

    public keys(): string[] {
        return this.#written;
    }
}

describe("watchPendingWork", () => {
    it("names every call still in flight and none that settled", async () => {
        expect.assertions(1);

        const slow = deferred();
        const ctx: Record<string, unknown> = {
            fetch: async () => "fetched",
            runMutation: () => slow.promise,
            storage: new Bucket(),
        };
        const finish = watchPendingWork(ctx);

        await (ctx.fetch as () => Promise<string>)();

        const running = [(ctx.runMutation as () => Promise<string>)(), (ctx.runMutation as () => Promise<string>)()];

        expect(finish()).toStrictEqual(["ctx.runMutation ×2"]);

        slow.resolve();
        await Promise.all(running);
    });

    it("settles the caller's promise exactly as the call's own promise settles", async () => {
        expect.assertions(3);

        const failure = new Error("mutation failed");
        const original = Promise.reject(failure);
        const ctx: Record<string, unknown> = { runMutation: () => original };

        watchPendingWork(ctx);

        const handed = (ctx.runMutation as () => Promise<unknown>)();

        // A distinct promise: watching the original itself would mark it handled and
        // swallow the unhandled rejection of a call the handler never awaits.
        expect(handed).not.toBe(original);
        await expect(handed).rejects.toBe(failure);
        await expect(original).rejects.toBe(failure);
    });

    it("calls a facade method on the facade itself", async () => {
        expect.assertions(2);

        const bucket = new Bucket();
        const ctx: Record<string, unknown> = { storage: bucket };

        watchPendingWork(ctx);

        // Private fields only resolve on the real instance, so a proxied `this` would throw here.
        await (ctx.storage as Bucket).put("a");

        expect(bucket.keys()).toStrictEqual(["a"]);
        expect(ctx.storage).not.toBe(bucket);
    });

    it("restores the original members so identity-keyed queues still find the facade", () => {
        expect.assertions(2);

        const bucket = new Bucket();
        const fetch = async (): Promise<string> => "fetched";
        const ctx: Record<string, unknown> = { fetch, storage: bucket };

        watchPendingWork(ctx)();

        expect(ctx.storage).toBe(bucket);
        expect(ctx.fetch).toBe(fetch);
    });
});

interface LoggedLine {
    fields?: Record<string, unknown>;
    functionPath?: string;
    level: string;
}

class ActionShard extends ShardDO {
    public readonly slow = deferred();

    /** The call `jobs:leaky` starts and never awaits. */
    public leaked: Promise<string> | undefined;

    public override async handleRpc(functionPath: string): Promise<unknown> {
        const ctx: Record<string, unknown> = { runMutation: () => this.slow.promise };
        const finish = this.watchActionWork(functionPath, ctx);

        if (functionPath === "jobs:leaky") {
            this.leaked = (ctx.runMutation as () => Promise<string>)();
        } else {
            await (ctx.runMutation as () => Promise<string>)();
        }

        finish();

        return { ok: true };
    }

    public loggedLines(): LoggedLine[] {
        return (this as unknown as { logs: { entries: () => LoggedLine[] } }).logs.entries();
    }
}

const createShard = (): ActionShard => {
    const harness = createSqliteExec();

    runShardMigrations(harness.sql, { tables: {} } satisfies SchemaLike);

    return new ActionShard(
        {
            acceptWebSocket: () => undefined,
            getWebSockets: () => [],
            storage: { sql: harness.sql as unknown as ShardDOState["storage"]["sql"] },
        },
        {},
    );
};

const rpc = (shard: ShardDO, functionPath: string): Promise<Response> =>
    shard.fetch(
        new Request("https://shard.internal/rpc", {
            body: JSON.stringify({ args: {}, functionPath }),
            headers: { "content-type": "application/json" },
            method: "POST",
        }),
    );

describe("shardDO.watchActionWork", () => {
    it("logs a warn line naming the call an action left running", async () => {
        expect.assertions(1);

        const shard = createShard();

        await rpc(shard, "jobs:leaky");

        expect(shard.loggedLines().filter((line) => line.level === "warn")).toStrictEqual([
            expect.objectContaining({ fields: { pending: ["ctx.runMutation"] }, functionPath: "jobs:leaky" }),
        ]);
    });

    it("stays quiet when the action awaited its work", async () => {
        expect.assertions(1);

        const shard = createShard();

        shard.slow.resolve();
        await rpc(shard, "jobs:tidy");

        expect(shard.loggedLines().filter((line) => line.level === "warn")).toHaveLength(0);
    });
});
