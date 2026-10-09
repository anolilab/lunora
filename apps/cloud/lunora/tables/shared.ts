/**
 * Validators more than one group of tables shares (`lunora/tables/*.ts`) — and
 * `deployTarget`, which `projects.setTarget` validates its argument with too.
 *
 * Spelled out rather than computed: codegen reads the schema statically, and a
 * computed union would type as `unknown`.
 */
import { v } from "@lunora/server";

export const plan = v.union(v.literal("free"), v.literal("pro"), v.literal("enterprise"));

/**
 * Every billable dimension the platform meters into `platformUsage`.
 *
 * Honest about its origin: these are Cloudflare's billing dimensions, because
 * `cloudflare-wfp` is the target whose costs the platform pays and rebills.
 * `requests` is the one every target produces (the usage rollback writes it
 * through each driver's readback); the Cloudflare readbacks also write the D1
 * and Durable Object row meters; the rest are what a WfP tenant consumes on
 * the platform's account. A target billed some other way (plan 458: per box)
 * adds its own meter rather than reinterpreting these.
 *
 * This list is spelled out here rather than imported because codegen reads this
 * file statically — a computed union would emit nothing. The pairing with
 * `UsageMeter` in `src/billing/spend.ts` (which prices each meter) is held by a
 * type-level assertion in `__tests__/spend.test.ts`, so adding a meter in one
 * place and forgetting the other fails `lint:types`, not production.
 */
export const usageMeter = v.union(
    v.literal("aeDataPoints"),
    v.literal("aeReadQueries"),
    v.literal("browserHours"),
    v.literal("containerCpuSeconds"),
    v.literal("containerDiskGbSeconds"),
    v.literal("containerMemoryGibSeconds"),
    v.literal("cpuMs"),
    v.literal("d1RowsRead"),
    v.literal("d1RowsWritten"),
    v.literal("d1StorageGbMonths"),
    v.literal("doDurationGbS"),
    v.literal("doRequests"),
    v.literal("doRowsRead"),
    v.literal("doRowsWritten"),
    v.literal("doStorageGbMonths"),
    v.literal("imagesDelivered"),
    v.literal("imagesStored"),
    v.literal("imagesTransformations"),
    v.literal("kvDeletes"),
    v.literal("kvLists"),
    v.literal("kvReads"),
    v.literal("kvStorageGbMonths"),
    v.literal("kvWrites"),
    v.literal("logEvents"),
    v.literal("logpushRequests"),
    v.literal("queueOperations"),
    v.literal("r2ClassAOps"),
    v.literal("r2ClassBOps"),
    v.literal("r2StorageGbMonths"),
    v.literal("requests"),
    v.literal("vectorizeQueriedDimensions"),
    v.literal("vectorizeStoredDimensions"),
    v.literal("workersAiNeurons"),
    v.literal("workflowSteps"),
    v.literal("workflowStorageGbMonths"),
);

/**
 * What an alert rule watches — `AlertTarget` in `src/telemetry/alerts.ts`, as a
 * validator. One declaration for the rule table, the fired-alert table and
 * `alerts.createRule`, which each carried their own copy of the union.
 */
export const alertTarget = v.union(
    v.literal("issue"),
    v.literal("incident"),
    v.literal("uptime"),
    v.literal("error_rate"),
    v.literal("latency_p95"),
    v.literal("llm_cost"),
    v.literal("deploy"),
    v.literal("spend"),
    v.literal("usage_anomaly"),
    v.literal("error_anomaly"),
    v.literal("storage_anomaly"),
);

/** An anomaly target — the subset of {@link alertTarget} a silence can name. */
export const anomalyTarget = v.union(v.literal("usage_anomaly"), v.literal("error_anomaly"), v.literal("storage_anomaly"));

export const memberRole = v.union(v.literal("owner"), v.literal("admin"), v.literal("member"), v.literal("viewer"));

/**
 * A deploy target: `TARGET_IDS` in `src/provision-contract.ts`, as a validator.
 * `__tests__/placement.test.ts` fails the type check when the two drift.
 */
export const deployTarget = v.union(v.literal("celld-vps"), v.literal("cloudflare-wfp"), v.literal("cloudflare-workers"));

/**
 * A project runtime that is not the default: `PROJECT_RUNTIMES` in
 * `src/project-runtime.ts` minus `lunora`, which is stored as absence so every
 * row that predates the setting already reads as a Lunora app.
 */
export const storedProjectRuntime = v.literal("worker");

/**
 * A placement's host (`projects.placementRef`, `src/targets/placement.ts`
 * `PLACEMENT_HOSTS`): a row of the table its target's `placedOn` implies — a box
 * the organization enrolled, or a Cloudflare account it connected. One column
 * for every kind of host, so no layer threads one nullable reference per kind.
 */
export const placementHost = v.union(v.id("boxes"), v.id("cloudflareAccounts"));
