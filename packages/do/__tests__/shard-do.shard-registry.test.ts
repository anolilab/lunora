import { ADMIN_FUNCTIONS } from "@lunora/shard-engine";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ShardDOState } from "../src/shard-do";
import { ShardDO } from "../src/shard-do";
import { SHARD_REGISTRY_DO_NAME } from "../src/shard-registry-do";
import createSqliteExec from "./_helpers/node-sqlite";

let database: ReturnType<typeof createSqliteExec>;

const ADMIN_TOKEN = "admin-token";

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
    route: string;
}

/** A registry namespace that records every `/register` call and answers `status`. */
const fakeRegistry = (status = 200): { calls: RegistryCall[]; namespace: unknown; setStatus: (next: number) => void } => {
    const calls: RegistryCall[] = [];
    let current = status;

    const namespaceFor = (jurisdiction?: string): unknown => {
        return {
            get: (name: string) => {
                return {
                    fetch: async (url: string, init?: RequestInit) => {
                        calls.push({ body: JSON.parse(init?.body as string), jurisdiction, name, route: new URL(url).pathname });

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
        super(state, { LUNORA_ADMIN_TOKEN: ADMIN_TOKEN });
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

    /** The `releaseShardRegistration` admin RPC, as the worker's prune fan-out sends it. */
    public async release(tables: string[], dryRun = false): Promise<Response> {
        return this.fetch(
            new Request("https://shard.internal/rpc", {
                body: JSON.stringify({ args: { dryRun, tables }, functionPath: ADMIN_FUNCTIONS.releaseShardRegistration }),
                headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "content-type": "application/json" },
                method: "POST",
            }),
        );
    }

    protected override shardRegistry(): undefined | { namespace: unknown; shardedTables: ReadonlySet<string> } {
        return this.registryNamespace === undefined ? undefined : { namespace: this.registryNamespace, shardedTables: new Set(["messages", "threads"]) };
    }
}

/** Give the shard a `messages` table holding one row. */
const seedMessages = (): void => {
    database.raw('CREATE TABLE "messages" ("_id" TEXT PRIMARY KEY)');
    database.raw(`INSERT INTO "messages" ("_id") VALUES ('m1')`);
};

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

        expect(registry.calls).toStrictEqual([
            { body: { shardKey: "channel-1", table: "messages" }, jurisdiction: undefined, name: SHARD_REGISTRY_DO_NAME, route: "/register" },
        ]);
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

    describe("releaseShardRegistration", () => {
        it("releases a table the shard holds no rows of and keeps one it does", async () => {
            expect.assertions(2);

            const registry = fakeRegistry();
            const shard = new RegistryShard(makeState(), registry.namespace);

            seedMessages();

            const response = await shard.release(["messages", "threads"]);

            await expect(response.json()).resolves.toStrictEqual({ result: { kept: ["messages"], released: ["threads"] } });
            expect(registry.calls.map((call) => [call.route, call.body])).toStrictEqual([["/unregister", { shardKey: "channel-1", table: "threads" }]]);
        });

        it("reports without touching the registry on a dry run", async () => {
            expect.assertions(2);

            const registry = fakeRegistry();
            const shard = new RegistryShard(makeState(), registry.namespace);

            const response = await shard.release(["threads"], true);

            await expect(response.json()).resolves.toStrictEqual({ result: { kept: [], released: ["threads"] } });
            expect(registry.calls).toStrictEqual([]);
        });

        it("re-registers on the next write after a release, rather than trusting a stale claim", async () => {
            expect.assertions(1);

            const registry = fakeRegistry();
            const shard = new RegistryShard(makeState(), registry.namespace);

            await shard.write("messages");
            await shard.release(["messages"]);
            await shard.write("messages");

            expect(registry.calls.map((call) => call.route)).toStrictEqual(["/register", "/unregister", "/register"]);
        });

        it("refuses when the shard has no registry bound", async () => {
            expect.assertions(1);

            const shard = new RegistryShard(makeState(), undefined);

            await expect(shard.release(["messages"]).then((response) => response.status)).resolves.toBe(400);
        });
    });
});
