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

import type { DatabaseWriterLike, TableDefinitionLike } from "./ctx-db";

/** Lifecycle phase relative to the SQL write. */
export type TriggerTimingLike = "after" | "before";

/** The CRUD operation a trigger reacts to. `patch` and `replace` both map to `update`. */
export type TriggerOpLike = "delete" | "insert" | "update";

/**
 * A schedulable durable-workflow reference — the generated `workflows.&lt;name>` /
 * `agents.&lt;name>` object (carries its `WORKFLOW_*`/`AGENT_*` binding + stable
 * name). Structural mirror so a scheduled target can be a workflow/agent, not
 * just a function path, without this package depending on `@lunora/scheduler`.
 */
export interface SchedulableWorkflowReferenceLike {
    readonly binding?: string;
    readonly isLunoraWorkflow: true;
    readonly name?: string;
}

/**
 * Structural mirror of `@lunora/server`'s `Scheduler` (kept local so this
 * package takes no runtime dependency on the server package — same reasoning
 * as `RelationDefinitionLike`). `target` is a function path (`"ns:fn"`) or a
 * generated `workflows.&lt;name>` / `agents.&lt;name>` reference (starts a fresh
 * durable instance on fire).
 */
export interface SchedulerLike {
    runAfter: (delayMs: number, target: SchedulableWorkflowReferenceLike | string, args?: Record<string, unknown>) => Promise<string>;
    runAt: (timestampMs: number, target: SchedulableWorkflowReferenceLike | string, args?: Record<string, unknown>) => Promise<string>;
}

/** What a trigger handler observes about the write that fired it. */
export interface TriggerEventLike {
    /** The new/merged row — present on `insert` and `update`, absent on `delete`. */
    doc?: Record<string, unknown>;
    id: string;
    op: TriggerOpLike;
    /** The pre-write row — present on `update` and `delete`, absent on `insert`. */
    previous?: Record<string, unknown>;
    table: string;
}

/** Handle injected into trigger handlers; built by the backend write layer. */
export interface TriggerContextLike {
    db: DatabaseWriterLike;
    scheduler: SchedulerLike;
}

/**
 * Structural mirror of `@lunora/server`'s `TriggerDefinition` (kept local —
 * same reasoning as `RelationDefinitionLike`). Stored on the table's
 * `triggerMap` keyed by accessor name.
 */
export interface TriggerDefinitionLike {
    readonly handler: (context: TriggerContextLike, event: TriggerEventLike) => Promise<void> | void;
    readonly op: TriggerOpLike;
    readonly timing: TriggerTimingLike;
}

export interface RunTriggersOptions {
    ctx: TriggerContextLike;
    event: TriggerEventLike;
    op: TriggerOpLike;
    schema: { readonly tables: Record<string, TableDefinitionLike> };
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
export const hasTrigger = (schema: { readonly tables: Record<string, TableDefinitionLike> }, tableName: string, op: TriggerOpLike): boolean => {
    const definitions = schema.tables[tableName]?.triggerMap;

    if (!definitions) {
        return false;
    }

    return Object.values(definitions).some((definition) => definition.op === op);
};
