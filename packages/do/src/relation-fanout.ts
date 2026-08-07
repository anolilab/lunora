/* eslint-disable no-secrets/no-secrets -- the `__lunora_relation__:` reserved-prefix template strings are framework constants, not credentials */
import { LunoraError } from "@lunora/errors";
import type { DatabaseWriterLike, QueryArgs, SchemaLike } from "@lunora/shard-engine";
import { RELATION_FUNCTION_PREFIX } from "@lunora/shard-engine";

/**
 * Serve a reserved `__lunora_relation__:read` / `:count` fan-out read for reverse
 * cross-backend relations — a `.global()` (D1) parent loading a shard-local child
 * whose rows span every shard. Returns a BARE value (the child-row array for
 * `:read`, a number for `:count`) so the Query Coordinator's `concat`/`sum` merge
 * composes the per-shard results.
 *
 * This is the body of the codegen-emitted `ShardDO.runRelationFanoutRead`
 * override, extracted into the canonical `@lunora/do` layer so the guard branches
 * and the read/count dispatch are real, type-checked, unit-testable code rather
 * than a template literal in the emitter (the emitted override is a one-line
 * delegation). The guards (`UNKNOWN_TABLE`, `global`-table rejection) run BEFORE
 * the read, but the caller has already built `database` (and run
 * `ensureMigrated()`), so an invalid request still pays for `buildCtx()` —
 * acceptable, since the coordinator only ever fans this out for real shard-local
 * relation tables.
 * @param schema The generated schema (for the table + `shardMode` lookup).
 * @param database The request's schema-aware ctx-db writer (built by the subclass).
 * @param functionPath The reserved path — `${RELATION_FUNCTION_PREFIX}read` or `:count`.
 * @param args The fan-out args (`CrossShardReadArgs` + `table`): `{ table, where?, orderBy?, with?, relationPolicies? }`.
 */
// eslint-disable-next-line import/prefer-default-export -- named export: import sites stay uniform (`import { serveRelationFanout }`), per the repo's no-default-mixing convention
export const serveRelationFanout = async (
    schema: SchemaLike,
    database: DatabaseWriterLike,
    functionPath: string,
    args: Record<string, unknown>,
): Promise<unknown> => {
    const table = typeof args["table"] === "string" ? args["table"] : "";
    const definition = schema.tables[table];

    if (!definition) {
        throw new LunoraError("UNKNOWN_TABLE", `${RELATION_FUNCTION_PREFIX} unknown table "${table}"`, { status: 404 });
    }

    // Only shard-local tables live in a shard's SQLite; a `.global()` table lives
    // in D1 and must never be fanned out across shards.
    if (definition.shardMode?.kind === "global") {
        throw new LunoraError("BAD_REQUEST", `${RELATION_FUNCTION_PREFIX} table "${table}" is global, not shard-local`);
    }

    const where = (args["where"] ?? undefined) as QueryArgs["where"];

    if (functionPath === `${RELATION_FUNCTION_PREFIX}count`) {
        return database.count(table, where);
    }

    // SECURITY: `database` is the RAW ctx-db — it applies no read policy of its
    // own. The caller's policy for THIS hop is already folded into `where`; the
    // policies for the nested `with` hops arrive as the `relationPolicies` map and
    // are rebuilt here into the `relationBaseWhere` the relation loader threads
    // down each level. Skipping this returns children the caller cannot read.
    const relationPolicies = (args["relationPolicies"] ?? {}) as Record<string, QueryArgs["where"]>;

    // `orderBy` / `where` / `with` arrive JSON-serialized through the fan-out
    // envelope (their compile-time types are erased), so cast the reconstructed
    // args to the writer's argument type.
    const result = await database.findMany(table, {
        orderBy: args["orderBy"],
        relationBaseWhere: (relationTable: string) => relationPolicies[relationTable],
        where,
        with: args["with"],
    } as QueryArgs);

    return result.page;
};
