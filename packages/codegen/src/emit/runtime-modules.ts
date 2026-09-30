import type { CronJobIR, TableIR, VectorIndexIR } from "../ir";
import { isShardByTable } from "../ir";
import { baseSpecifiers, GENERATED_HEADER } from "./shared";

/**
 * Emit `_generated/crons.ts` from the discovered cron jobs.
 *
 * `LUNORA_CRON_TRIGGERS` is the deduplicated schedule array — what lands in
 * wrangler's `triggers.crons` (the vite plugin reconciles it into
 * `wrangler.jsonc`, and {@link emitWranglerCronTriggers} renders the same list
 * for the CLI / docs).
 *
 * `LUNORA_CRONS` is the dispatcher map keyed by cron expression, each value a
 * list of `{ name, functionPath, args }`. Cloudflare's `scheduled()` handler
 * receives only the cron string, so multiple jobs sharing one expression must
 * all fire — hence a list per key rather than a single entry.
 *
 * Jobs arrive pre-sorted by name (deterministic output); the trigger array
 * preserves first-seen order of distinct expressions.
 *
 * Cloudflare caps a Worker at **3 Cron Triggers** (i.e. 3 distinct cron
 * expressions). Because the dispatcher fires every job sharing an expression,
 * many jobs can ride a single trigger — only the count of *distinct* schedules
 * matters. `lunora codegen` warns when that count exceeds the limit; for
 * finer-grained scheduling use Durable Object alarms (`@lunora/scheduler`),
 * which have no such cap.
 */

/**
 * Emit `_generated/scheduler.ts` — the `SchedulerDO` class re-export, or `""`
 * when the app has no scheduler (the file is not written then).
 *
 * It exists so the class-A composed entry has something to FORWARD. wrangler
 * binds only what the worker entry exports, and `@lunora/vite` generates that
 * entry, so a Vite-first app had no file to add the re-export to and
 * `ctx.scheduler.runAfter` / `runAt` were unreachable.
 *
 * Emitted off the same `hasScheduler` that decides whether the builder even HAS
 * a `.scheduler()` method, and that is the whole point: the plugin composes the
 * call and the re-export off THIS FILE's existence, so the two cannot disagree.
 * Keying the plugin on the `wrangler.jsonc` binding instead let a project
 * declare the binding with no scheduler code and get
 * `TypeError: ….scheduler is not a function` at worker boot, from inside a
 * virtual module.
 *
 * `@lunora/scheduler` stays scoped — the umbrella ships no `./scheduler`
 * subpath — and `assertRequiredPackages` already demands the dependency off the
 * same signal, so the specifier cannot go unresolvable.
 */
const emitScheduler = (hasScheduler: boolean): string => {
    if (!hasScheduler) {
        return "";
    }

    return `${GENERATED_HEADER}/**
 * The \`SchedulerDO\` Durable Object class, re-exported so a worker entry can
 * forward it — wrangler binds only what the entry exports:
 *
 * \`export * from "./lunora/_generated/scheduler.js";\`
 *
 * A Vite-first (class-A) app needs no such line: the generated worker entry
 * forwards this module for you whenever it exists.
 */
export { SchedulerDO } from "@lunora/scheduler";
`;
};

/**
 * `_generated/shardRegistry.ts` — the `ShardRegistryDO` class, emitted only for a
 * schema with `.shardBy()` tables (the file is not written otherwise).
 *
 * The scheduler module's twin, for the same reason: the class-A composed entry
 * forwards this module and adds the builder's `.shardRegistry(...)` call off
 * this FILE's existence, and binding inference provisions `SHARD_REGISTRY` off
 * the same signal — so none of the three can disagree about whether the app has
 * a registry.
 */
const emitShardRegistry = (tables: ReadonlyArray<Pick<TableIR, "shardMode">>, useUmbrella: boolean): string => {
    if (!tables.some((table) => isShardByTable(table))) {
        return "";
    }

    return `${GENERATED_HEADER}/**
 * The \`ShardRegistryDO\` Durable Object class — the live set of shard keys per
 * \`.shardBy()\` table, which cross-shard export, CDC sync and migrations fan out
 * to. Re-exported so a worker entry can forward it (wrangler binds only what the
 * entry exports), next to \`.shardRegistry((env) => env.SHARD_REGISTRY)\`:
 *
 * \`export { ShardRegistryDO } from "./lunora/_generated/shardRegistry.js";\`
 *
 * Name the class in a hand-written entry: binding inference provisions
 * \`SHARD_REGISTRY\` off the entry's named exports, and cannot see through an
 * \`export *\`. A Vite-first (class-A) app needs neither line — its generated
 * worker entry does both whenever this module exists.
 */
export { ShardRegistryDO } from "${baseSpecifiers(useUmbrella).do}";
`;
};

const emitCrons = (crons: ReadonlyArray<CronJobIR>): string => {
    const byExpression = new Map<string, CronJobIR[]>();

    for (const cron of crons) {
        const existing = byExpression.get(cron.cron);

        if (existing) {
            existing.push(cron);
        } else {
            byExpression.set(cron.cron, [cron]);
        }
    }

    const triggerEntries = [...byExpression.keys()].map((expression) => `    ${JSON.stringify(expression)},`).join("\n");
    const triggerBody = triggerEntries.length > 0 ? `\n${triggerEntries}\n` : "";

    const mapEntries = [...byExpression.entries()]
        .map(([expression, jobs]) => {
            const jobEntries = jobs
                .map((job) => {
                    // A workflow target starts a durable instance per fire (args ⇒
                    // its `params`); a function target dispatches `namespace:fn` to
                    // the shard. The two are mutually exclusive in the emitted entry.
                    const targetField = job.workflow
                        ? `workflow: ${JSON.stringify(job.workflow.binding)}`
                        : `functionPath: ${JSON.stringify(job.functionPath)}`;

                    return `        { name: ${JSON.stringify(job.name)}, ${targetField}, args: ${JSON.stringify(job.args)} },`;
                })
                .join("\n");

            return `    ${JSON.stringify(expression)}: [\n${jobEntries}\n    ],`;
        })
        .join("\n");

    const mapBody = mapEntries.length > 0 ? `\n${mapEntries}\n` : "";

    return `${GENERATED_HEADER}/**
 * One scheduled cron invocation. Exactly one target is set: \`functionPath\` is
 * the \`namespace:fn\` dispatch ref (matches \`__lunoraRef\`), invoked on the
 * shard; \`workflow\` is a \`WORKFLOW_*\` binding name whose durable workflow is
 * started fresh per fire. \`args\` are forwarded verbatim (a workflow's become
 * its \`params\`).
 */
export interface LunoraCronJob {
    args: Record<string, unknown>;
    functionPath?: string;
    name: string;
    workflow?: string;
}

/**
 * Deduplicated cron schedules — mirror of wrangler's \`triggers.crons\`. The
 * Lunora vite plugin keeps \`wrangler.jsonc\` in sync with this array.
 */
export const LUNORA_CRON_TRIGGERS: ReadonlyArray<string> = [${triggerBody}];

/**
 * Dispatcher map keyed by cron expression. The Worker's \`scheduled()\` handler
 * looks up \`event.cron\` here and dispatches every job in the list.
 */
export const LUNORA_CRONS: Record<string, ReadonlyArray<LunoraCronJob>> = {${mapBody}};
`;
};

/**
 * Render `_generated/vectors.ts` — the static registry of every vector index
 * declared in `schema.ts` (inline `.vectorize()` columns + standalone
 * `defineVectorIndex()` definitions).
 *
 * Cloudflare Vectorize exposes no way to enumerate an account's indexes at
 * runtime — a binding can `describe()` itself but the worker can't ask "which
 * indexes exist". So this generated array is the source of truth the studio's
 * vector browser lists, and the worker's admin route pairs each entry with its
 * live `describe()` stats. Entries are sorted by name for deterministic output.
 */
const emitVectors = (vectorIndexes: ReadonlyArray<VectorIndexIR>): string => {
    const entries = [...vectorIndexes]
        .toSorted((a, b) => a.name.localeCompare(b.name))
        .map((index) => {
            const parts = [`name: ${JSON.stringify(index.name)}`, `table: ${JSON.stringify(index.table)}`];

            if (index.field !== undefined) {
                parts.push(`field: ${JSON.stringify(index.field)}`);
            }

            if (index.dimensions !== undefined) {
                parts.push(`dimensions: ${JSON.stringify(index.dimensions)}`);
            }

            if (index.metric !== undefined) {
                parts.push(`metric: ${JSON.stringify(index.metric)}`);
            }

            if (index.metadata !== undefined) {
                parts.push(`metadata: ${JSON.stringify(index.metadata)}`);
            }

            return `    { ${parts.join(", ")} },`;
        })
        .join("\n");

    const body = entries.length > 0 ? `\n${entries}\n` : "";

    // eslint-disable-next-line no-secrets/no-secrets -- the emitted registry's type annotation is high-entropy but not a secret
    return `${GENERATED_HEADER}/**
 * One vector index declared in \`schema.ts\` — an inline \`.vectorize()\` column
 * or a standalone \`defineVectorIndex()\`. \`field\` is the source column (absent
 * for a \`select\`-derived Shape B index); \`metadata\` lists the row fields
 * mirrored into Vectorize for filtering.
 */
export interface LunoraVectorIndex {
    dimensions?: number;
    field?: string;
    metadata?: ReadonlyArray<string>;
    metric?: "cosine" | "dot-product" | "euclidean";
    name: string;
    table: string;
}

/**
 * Static registry of every vector index in the schema, sorted by name.
 * Vectorize cannot enumerate indexes at runtime, so the worker passes this to
 * \`createWorker({ vectorIntrospector })\` to back the studio's vector browser.
 */
export const LUNORA_VECTOR_INDEXES: ReadonlyArray<LunoraVectorIndex> = [${body}];
`;
};

/**
 * Render the deduplicated cron schedules as a JSON fragment suitable for
 * splicing into `wrangler.jsonc`'s `triggers.crons`. The vite plugin uses this
 * (plus the parsed wrangler config) to reconcile generated triggers without the
 * user hand-editing the file.
 */
const emitWranglerCronTriggers = (crons: ReadonlyArray<CronJobIR>): string[] => [...new Set(crons.map((cron) => cron.cron))];

export { emitCrons, emitScheduler, emitShardRegistry, emitVectors, emitWranglerCronTriggers };
