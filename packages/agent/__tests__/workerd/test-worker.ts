/**
 * Entry-point Worker and Durable Object for the `workerd` vitest project.
 *
 * `AgentStoreDO` runs the REAL agent component functions against a real shard
 * `ctx.db` (`createShardCtxDb`) over the Durable Object's own SQLite, with the
 * agent tables migrated from `agentExtension` — the same path a generated shard
 * takes. Nothing is mocked: storage, indexes and `gt` range reads are workerd's.
 */
import { defineSchema } from "@lunora/server";
import type { DatabaseWriterLike, SchemaLike } from "@lunora/shard-engine";
import { createShardCtxDb, runShardMigrations } from "@lunora/shard-engine";
import { DurableObject } from "cloudflare:workers";

import { agentComponent, agentExtension } from "../../src/component";

interface Env {
    AGENT_STORE: DurableObjectNamespace<AgentStoreDO>;
}

interface ComponentFunction {
    handler: (context: unknown, args: unknown) => Promise<unknown>;
}

const schema = defineSchema({}).extend(agentExtension) as unknown as SchemaLike;
const functions = agentComponent().functions as unknown as Record<string, ComponentFunction>;

class AgentStoreDO extends DurableObject<Env> {
    private db: DatabaseWriterLike | undefined;

    /** Run one component function (`agentPatchThread`, `agentHistory`, ...) by name; the result crosses RPC as JSON. */
    public async call(name: string, args: Record<string, unknown>): Promise<string> {
        const fn = functions[name];

        if (!fn) {
            throw new Error(`unknown component function "${name}"`);
        }

        return JSON.stringify((await fn.handler({ auth: {}, db: this.getDb() }, args)) ?? null);
    }

    private getDb(): DatabaseWriterLike {
        if (!this.db) {
            const sql = this.ctx.storage.sql as unknown as Parameters<typeof createShardCtxDb>[0]["sql"];

            runShardMigrations(sql, schema, { cdc: false });
            this.db = createShardCtxDb({ broadcast: () => undefined, cdc: false, clock: () => 1_700_000_000_000, schema, sql });
        }

        return this.db;
    }
}

const handler = {
    fetch: (): Response => new Response("agent workerd test worker"),
} satisfies ExportedHandler<Env>;

export default handler;
export { AgentStoreDO };
export type { Env };
