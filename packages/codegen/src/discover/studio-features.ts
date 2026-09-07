import type { StudioFeaturesResult } from "@lunora/shard-engine";

import type { FeatureUsage } from "./feature-usage";

/**
 * The extra schema-/project-level signals OR'd onto the code-usage flags to
 * decide which studio nav pages to show. These cover the wiring paths the
 * `lunora/`-scoped code scan structurally can't see: a `v.storage()` column with
 * no `ctx.storage` call, a cron with no `@lunora/scheduler` import, a vector
 * index, and — crucially for mail — a package wired only in the worker entry
 * (`src/server`), detected via the project's declared dependencies.
 */
interface StudioFeatureSignals {
    /** Number of declared containers — any `defineContainer` means the containers page is relevant. */
    containerCount: number;
    /** Number of declared cron jobs — any cron means the scheduler page is relevant. */
    cronCount: number;
    /** The `@lunora/*` packages this app depends on (from its `package.json`). */
    dependencies: ReadonlySet<string>;

    /**
     * The app declares the `@lunora/payment` store's `subscriptions` **and** `events` tables — the
     * two the Payments panel reads — identified by their *signature columns*, not merely their
     * (generic) names (see `hasPaymentStoreTables`). Unlike every other feature, payments has
     * no fail-open dependency arm: the panel queries these tables directly, so merely depending on
     * `@lunora/payment` (e.g. to reuse its pure webhook-verification / idempotency-key helpers)
     * without hand-declaring the store's tables would show a page that errors with `unknown table:
     * subscriptions`. Gating on the tables' presence makes the page appear exactly when it can
     * actually render — and gating on their *shape* keeps an unrelated newsletter `subscriptions`
     * or domain `events` table from spuriously flipping it on.
     */
    hasPaymentTables: boolean;
    /** Number of declared queues — any `defineQueue` means the queues page is relevant. */
    queueCount: number;
    /** Number of tables carrying a scalar `v.storage()` column — drives the file browser even with no `ctx.storage` use. */
    storageColumnCount: number;
    /** Number of declared storage access rules. */
    storageRuleCount: number;
    /** Number of declared vector indexes. */
    vectorIndexCount: number;

    /**
     * The platform gate's `vectorStore` verdict. `false` withholds the page
     * outright — the one signal that overrides the fail-open rule above, because
     * the host has no vector binding for the panel to read through. Codegen
     * withholds `ctx.vectors` and the shard's whole Vectorize wiring on the same
     * verdict; leaving the nav entry on advertises a binding that is not there.
     */
    vectorStoreSupported: boolean;
    /** Number of declared workflows — any `defineWorkflow` means the workflows page is relevant. */
    workflowCount: number;
}

/**
 * Combine the code-usage flags with the schema/project signals into the final
 * per-feature visibility the studio gates its nav on. A page shows when ANY
 * signal fires — usage is OR'd with the relevant schema count and with the
 * `@lunora/*` package being a declared dependency. The dependency arm is what
 * makes the gating fail *open*: it cannot hide a page for an app that pulls the
 * package in, even when the usage scan (scoped to `lunora/`) can't see the
 * wiring — the failure the studio must never make is hiding a working page.
 *
 * The dependency names tested here are PACKAGE names, which is what
 * `readPackageDependencies` collects — never a subpath. `analytics` and `kv` both
 * ship inside `@lunora/bindings`, so both test that one name; testing
 * `"@lunora/bindings/kv"` (as they did) matched nothing, and the arm that exists
 * to fail open could never fire. Both pages render an empty state on a
 * deployment that binds nothing — `createKvIntrospectorFromEnv` returns an
 * introspector whose namespace list is `[]` rather than erroring — so failing
 * open costs at most a page that says "none bound".
 *
 * `vectors` takes no dependency arm and no usage arm, because for it failing open
 * costs an error rather than an empty state. The page and the home-screen card
 * both call `/_lunora/admin/vector/indexes`, which the generated app.ts backs by
 * passing the `LUNORA_VECTOR_INDEXES` registry and the app's own `.vectors(...)`
 * binding map to `createVectorAdminIntrospector`. Both of those are emitted only
 * when the schema declares an index, so a declaration is exactly the condition
 * under which the tab has a backend — a bare `@lunora/bindings` dependency
 * (installed for `ctx.images`, say) or a `ctx.vectors` call against a schema with
 * no `.vectorize()` would show a tab that can only 400.
 *
 * The platform gate's `vectorStore` verdict AND's the expression on top of that:
 * codegen withholds `ctx.vectors` and the shard's Vectorize imports on that
 * verdict, and a nav entry pointing at what was just withheld is worse than a
 * hidden page.
 *
 * `payments` is the lone exception: it has no dependency arm. Its panel reads the
 * `subscriptions`/`events` tables directly, which the app must hand-declare in its
 * schema (codegen can't resolve `@lunora/payment`'s cross-package table spread), so
 * a dependency-only signal would fail *open into an error* rather than an empty
 * page. It gates on {@link StudioFeatureSignals.hasPaymentTables} — the store tables'
 * actual presence, matched by their signature columns (`hasPaymentStoreTables`)
 * — instead, so the page shows exactly when it can render.
 */
const buildStudioFeatures = (usage: FeatureUsage, signals: StudioFeatureSignals): StudioFeaturesResult => {
    return {
        analytics: usage.analytics || signals.dependencies.has("@lunora/bindings"),
        auth: signals.dependencies.has("@lunora/auth"),
        containers: usage.container || signals.containerCount > 0 || signals.dependencies.has("@lunora/container"),
        flags: usage.flags || signals.dependencies.has("@lunora/flags"),
        kv: usage.kv || signals.dependencies.has("@lunora/bindings"),
        mail: usage.mail || signals.dependencies.has("@lunora/mail"),
        notifications: usage.notify || signals.dependencies.has("@lunora/notify"),
        payments: usage.payments || signals.hasPaymentTables,
        queues: signals.queueCount > 0 || signals.dependencies.has("@lunora/queue"),
        scheduler: usage.scheduler || signals.cronCount > 0 || signals.dependencies.has("@lunora/scheduler"),
        storage: usage.storage || signals.storageRuleCount > 0 || signals.storageColumnCount > 0 || signals.dependencies.has("@lunora/storage"),
        vectors: signals.vectorStoreSupported && signals.vectorIndexCount > 0,
        workflows: usage.workflows || signals.workflowCount > 0 || signals.dependencies.has("@lunora/workflow"),
    };
};

export { buildStudioFeatures };
export type { StudioFeatureSignals };
