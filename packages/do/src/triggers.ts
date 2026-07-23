/**
 * Dialect-agnostic lifecycle-trigger runner shared by both ORM backends.
 *
 * Triggers are user-declared `before`/`after` hooks on a table's CRUD writes
 * (`.triggers((t) => …)` in `@lunora/server`). Unlike relations — which are
 * pure data descriptors — trigger handlers are **closures**, so they cannot
 * round-trip through codegen. They reach the runtime by riding the live
 * `schema` object the generated `shard.ts` imports (`import schema from
 * "../schema.js"`); this module just reads `triggerMap` off that schema and
 * fires the matching handlers.
 *
 * The trigger context (`{ db, scheduler }`) is injected by each backend's
 * write layer, so the same helper serves both the DO (`createShardCtxDb`) and
 * D1 (`createD1CtxDb`) dialects.
 *
 * Scope: **shard-local / same-backend only.** Triggers fire inline within the
 * write path, so a shard-local write and its triggers are atomic. Cross-shard
 * follow-up work is the handler's responsibility via `ctx.scheduler` and is
 * **not** transactional.
 */

import type {
    SchemaLike,
    TriggerContextLike,
    TriggerEventLike,
    TriggerOpLike,
    TriggerTimingLike,
} from "@lunora/shard-engine";

export type {
    SchedulableWorkflowReferenceLike,
    SchedulerLike,
    TriggerContextLike,
    TriggerDefinitionLike,
    TriggerEventLike,
    TriggerOpLike,
    TriggerTimingLike,
} from "@lunora/shard-engine";

export interface RunTriggersOptions {
    ctx: TriggerContextLike;
    event: TriggerEventLike;
    op: TriggerOpLike;
    schema: SchemaLike;
    tableName: string;
    timing: TriggerTimingLike;
}

/**
 * Fire every declared trigger on `tableName` whose `timing`+`op` match, in
 * declaration order, awaiting each. A throwing `before` handler propagates out
 * of the write — the SQL never runs — so guards can abort a write.
 */
export const runTriggers = async (options: RunTriggersOptions): Promise<void> => {
    const definitions = options.schema.tables[options.tableName]?.triggerMap;

    if (!definitions) {
        return;
    }

    for (const definition of Object.values(definitions)) {
        if (definition.timing === options.timing && definition.op === options.op) {
            // eslint-disable-next-line no-await-in-loop -- triggers fire in declaration order; each must settle before the next
            await definition.handler(options.ctx, options.event);
        }
    }
};

/**
 * Whether `tableName` declares any trigger for `op`. Lets the write layer skip
 * the extra `previous` read on `replace` unless an `update` trigger needs it.
 */
export const hasTrigger = (schema: SchemaLike, tableName: string, op: TriggerOpLike): boolean => {
    const definitions = schema.tables[tableName]?.triggerMap;

    if (!definitions) {
        return false;
    }

    return Object.values(definitions).some((definition) => definition.op === op);
};
