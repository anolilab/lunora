import { afterEach, describe, expect, it, vi } from "vitest";

import type { ShardDOState } from "../src/shard-do";
import { ShardDO } from "../src/shard-do";
import { SHARD_REGISTRY_DO_NAME } from "../src/shard-registry-do";
import createSqliteExec from "./_helpers/node-sqlite";

let database: ReturnType<typeof createSqliteExec>;

const makeState = (name = "channel-1", jurisdiction?: string): ShardDOState => {
    database = createSqliteExec();

    return {
        acceptWebSocket: () => undefined,
        blockConcurrencyWhile: async <R>(callback: () => Promise<R>): Promise<R> => callback(),
        getWebSockets: () => [],
        id: { jurisdiction, name },
        storage: { sql: database.sql as unknown as ShardDOState["storage"]["sql"] },
    };
};

interface RegistryCall {
    body: unknown;
    jurisdiction?: string;
    name: string;
}

/** A registry namespace that records every `/register` call and answers `status`. */
const fakeRegistry = (status = 200): { calls: RegistryCall[]; namespace: unknown; setStatus: (next: number) => void } => {
    const calls: RegistryCall[] = [];
    let current = status;

    const namespaceFor = (jurisdiction?: string): unknown => {
        return {
            get: (name: string) => {
                return {
                    fetch: async (_url: string, init?: RequestInit) => {
                        calls.push({ body: JSON.parse(init?.body as string), jurisdiction, name });

                        return new Response("{}", { status: current });
                    },
                };
            },
            idFromName: (name: string) => name,
            jurisdiction: (next: string) => namespaceFor(next),
        };
    };

    return {
        calls,
        namespace: namespaceFor(),
        setStatus: (next) => {
            current = next;
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

    /** Stand-in for a committed write: mark the tables changed, then run the post-write flush. */
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
        vi.useRealTimers();
    });

    it("registers its key for a written .shardBy() table, once per instance", async () => {
        expect.assertions(1);

        const registry = fakeRegistry();
        const shard = new RegistryShard(makeState(), registry.namespace);

        await shard.write("messages", "users");
        await shard.write("messages");

        expect(registry.calls).toStrictEqual([{ body: { shardKey: "channel-1", table: "messages" }, jurisdiction: undefined, name: SHARD_REGISTRY_DO_NAME }]);
    });

    it("registers in the shard's own jurisdiction, where the worker reads the registry", async () => {
        expect.assertions(1);

        const registry = fakeRegistry();
        const shard = new RegistryShard(makeState("channel-1", "eu"), registry.namespace);

        await shard.write("messages");

        expect(registry.calls.map((call) => call.jurisdiction)).toStrictEqual(["eu"]);
    });

    it.each(["channel-1::replica::weur", "channel-1::relay::0"])("does not register %s, which is not a shard of its own", async (name) => {
        expect.assertions(1);

        const registry = fakeRegistry();
        const shard = new RegistryShard(makeState(name), registry.namespace);

        await shard.write("messages");

        expect(registry.calls).toStrictEqual([]);
    });

    it("logs a failed registration without failing the write, and retries once the backoff passes", async () => {
        expect.assertions(4);

        vi.useFakeTimers({ now: 0 });

        const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
        const registry = fakeRegistry(500);
        const shard = new RegistryShard(makeState(), registry.namespace);

        await expect(shard.write("messages")).resolves.toBeUndefined();

        expect(error).toHaveBeenCalledWith(expect.stringContaining('could not register shard "channel-1" for "messages"'), expect.any(Error));

        // Inside the backoff window: no second round trip against a failing registry.
        registry.setStatus(200);
        await shard.write("messages");

        expect(registry.calls).toHaveLength(1);

        vi.setSystemTime(30_001);
        await shard.write("messages");
        await shard.write("messages");

        expect(registry.calls).toHaveLength(2);
    });

    it("reports a registry binding that is not a Durable Object namespace", async () => {
        expect.assertions(1);

        const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
        const shard = new RegistryShard(makeState(), { not: "a namespace" });

        await shard.write("messages");

        expect(error).toHaveBeenCalledWith(expect.stringContaining('shard "channel-1" is not registered'));
    });
});
