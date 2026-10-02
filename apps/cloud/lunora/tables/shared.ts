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
 * through each driver's readback); the rest are what a WfP tenant consumes on
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

export const memberRole = v.union(v.literal("owner"), v.literal("admin"), v.literal("member"), v.literal("viewer"));

/**
 * A deploy target: `TARGET_IDS` in `src/provision-contract.ts`, as a validator.
 * `__tests__/placement.test.ts` fails the type check when the two drift.
 */
export const deployTarget = v.union(v.literal("celld-vps"), v.literal("cloudflare-wfp"), v.literal("cloudflare-workers"));
