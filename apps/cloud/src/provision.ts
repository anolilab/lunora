/**
 * `@cirrus/provision` — the control plane's ONLY coupling to the provisioning
 * engine (Alchemy v2 / `alchemy@next`, Effect-based; see CLOUD-PLAN.md §2.2 and
 * risk #7). Everything Alchemy- or Effect-shaped lives behind this interface;
 * nothing above it imports `alchemy` or `effect`. This keeps a beta dependency
 * on the revenue path contained to one module, and lets the per-cell rate-limit
 * scheduler (§2.5) drive provisioning without knowing how it's implemented.
 *
 * It is intentionally a stub: the real implementation is a Phase 1 spike
 * deliverable (stand it up against one cell, confirm v2 exposes the
 * `DispatchNamespace` resource + a control-plane-D1-backed state store).
 */

/** Per-tenant bindings to provision alongside a tenant Worker (§2.1). */
export interface TenantBindingSpec {
    /** Provision (or reuse) a per-tenant D1 database under this binding name. */
    d1?: { binding: string };
    /** Durable Object classes the tenant bundle exports (ShardDO / SessionDO …). */
    durableObjects?: { binding: string; className: string }[];
    /** Provision (or reuse) a per-tenant R2 bucket under this binding name. */
    r2?: { binding: string };
}

/** A single managed-tier deployment to converge into a dispatch namespace. */
export interface TenantDeploymentSpec {
    /** Bindings to attach in the script-upload metadata. */
    bindings: TenantBindingSpec;
    /** Prebuilt worker bundle (output of the app's Vite pipeline — never built here). */
    bundle: ArrayBuffer;
    /** Which cell (Cloudflare account) hosts this tenant (§2.5). */
    cell: string;
    /** Dispatch namespace to deploy into (e.g. `cirrus-production`). */
    dispatchNamespace: string;
    /** Dispatch-namespace script id. */
    scriptName: string;
    /** Per-deployment secrets, applied via the WfP script-secrets API. */
    secrets: Record<string, string>;
    /** Lifecycle tags: `org:…`, `project:…`, `env:…`, `plan:…` (§2.1). */
    tags: string[];
}

export interface ProvisionResult {
    bundleHash: string;
    scriptName: string;
    url: string;
}

export interface DestroyRef {
    cell: string;
    scriptName: string;
}

/**
 * The provisioning contract. One scope per `{cell, project, deployment}`; the
 * adapter backs Alchemy state with the control-plane D1 so there is a single
 * source of truth (§2.2).
 */
export interface Provisioner {
    /** Converge a tenant deployment (create/update). Idempotent — safe to retry. */
    deploy: (spec: TenantDeploymentSpec) => Promise<ProvisionResult>;
    /** Tear a deployment down (preview TTL cleanup, project deletion). */
    destroy: (reference: DestroyRef) => Promise<void>;
}

export interface AlchemyProvisionerOptions {
    /** Cell identifier this provisioner operates within. */
    cell: string;
    /** Cloudflare API token for the cell's account. */
    cloudflareApiToken: string;
}

const NOT_WIRED = "provisioner not wired yet — Phase 1 spike: implement over alchemy@next (CLOUD-PLAN.md §2.2, risk #7)";

/**
 * Construct the Alchemy-backed provisioner for a cell.
 *
 * STUB. The real body runs Alchemy v2 in-process against the cell's account
 * (`const app = await alchemy(scope)` → declare `DispatchNamespace` / `Worker`
 * / `D1Database` / `R2Bucket` → `await app.finalize()`), with state in a
 * control-plane-D1-backed store. Left unimplemented on purpose so the boundary
 * exists without faking calls to an unverified beta API.
 */
export const createAlchemyProvisioner = (options: AlchemyProvisionerOptions): Provisioner => {
    const notWired = (): Error => new Error(`${NOT_WIRED} (cell ${options.cell})`);

    return {
        deploy: () => Promise.reject(notWired()),
        destroy: () => Promise.reject(notWired()),
    };
};
