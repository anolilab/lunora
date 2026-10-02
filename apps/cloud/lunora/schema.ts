import { defineSchema } from "@lunora/server";

import { billingTables } from "./tables/billing";
import { boxesTables } from "./tables/boxes";
import { deployTables } from "./tables/deploy";
import { observabilityTables } from "./tables/observability";
import { platformTables } from "./tables/platform";

/**
 * Lunora Cloud control-plane data model. This is the *platform's* own schema,
 * dogfooded on Lunora itself (the platform's metadata store is a Lunora app).
 * The topology it encodes — cells, and one organization placed on one cell — is
 * described in `README.md`.
 *
 * Every table is `.global()` (D1-backed): the control plane is the "Worker + D1"
 * service of the plan, and its bookkeeping is relational, cross-queried, and low
 * volume relative to tenant app data. (Per-tenant *sharding* in the plan refers
 * to the tenant apps' own ShardDOs, not the control plane's metadata.) Reads use
 * the per-table `findMany({ where })` facade; the fluent `query()` / `withIndex()`
 * reader is not available on the D1 backend.
 *
 * The tables are declared by domain in `lunora/tables/*.ts`; codegen follows
 * these spreads as it reads the schema.
 */

export default defineSchema({
    ...platformTables,
    ...deployTables,
    ...boxesTables,
    ...observabilityTables,
    ...billingTables,
});
