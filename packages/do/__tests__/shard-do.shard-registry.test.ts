import { afterEach, describe, expect, it, vi } from "vitest";

import type { ShardDOState } from "../src/shard-do";
import { ShardDO } from "../src/shard-do";
import createSqliteExec from "./_helpers/node-sqlite";

let database: ReturnType<typeof createSqliteExec>;

const makeState = (): ShardDOState => {
    database = createSqliteExec();

    return {
        acceptWebSocket: () => undefined,
        blockConcurrencyWhile: async <R>(callback: () => Promise<R>): Promise<R> => callback(),
        getWebSockets: () => [],
        id: { name: "channel-1" },
        storage: { sql: database.sql as unknown as ShardDOState["storage"]["sql"] },
    };
};

/** A registry namespace that records every `/register` body and answers `status`. */
const fakeRegistry = (status = 200): { calls: { body: unknown; name: string }[]; namespace: unknown } => {
    const calls: { body: unknown; name: string }[] = [];

    return {
        calls,
        namespace: {
            get: (name: string) => {
                return {
                    fetch: async (_url: string, init?: RequestInit) => {
                        calls.push({ body: JSON.parse(init?.body as string), name });

                        return new Response("{}", { status });
                    },
                };
            },
            idFromName: (name: string) => name,
        },
    };
};

class RegistryShard extends ShardDO {
    public constructor(
        state: ShardDOState,
        private readonly registryNamespace: unknown,
    ) {
        super(state, {});
    }

    // eslint-disable-next-line class-methods-use-this -- override stub; this suite drives the flush directly
    public override async handleRpc(): Promise<unknown> {
        return null;
    }

    /** Stand-in for a committed write: mark the tables changed, then flush. */
    public async write(...tables: string[]): Promise<void> {
        for (const table of tables) {
            this.recordChangedTable(table);
        }

        await this.flushMigrationProgress();
    }

    protected override shardRegistry(): { namespace: unknown; shardedTables: ReadonlySet<string> } {
        return { namespace: this.registryNamespace, shardedTables: new Set(["messages"]) };
    }
}

describe("shardDO — shard registry", () => {
    afterEach(() => {
        database.close();
        vi.restoreAllMocks();
    });

    it("registers its key for a written .shardBy() table, once per instance", async () => {
        expect.assertions(1);

        const registry = fakeRegistry();
        const shard = new RegistryShard(makeState(), registry.namespace);

        await shard.write("messages", "users");
        await shard.write("messages");

        expect(registry.calls).toStrictEqual([{ body: { shardKey: "channel-1", table: "messages" }, name: "__lunora_shard_registry__" }]);
    });

    it("keeps a failed registration pending so the next write retries it", async () => {
        expect.assertions(2);

        vi.spyOn(console, "error").mockImplementation(() => undefined);

        const registry = fakeRegistry(500);
        const shard = new RegistryShard(makeState(), registry.namespace);

        // The write itself must not fail: it has already committed.
        await expect(shard.write("messages")).resolves.toBeUndefined();

        await shard.write("messages");

        expect(registry.calls).toHaveLength(2);
    });
});
