/**
 * The provisioning contract, shared by the three parties that meet at it:
 *
 * - the **CLI** (`lunora cloud deploy`) sends a {@link DeployManifest} and, when
 *   the app serves static files, an {@link AssetsUpload} in the `POST /v1/deploy`
 *   body. `packages/cli` cannot import this private app, so it mirrors these
 *   shapes in `src/util/cloud-client.ts` — change both together.
 * - the **deploy handler** validates that body against {@link BINDING_SUPPORT},
 *   refuses what the platform cannot provide, and hands a
 *   {@link TenantDeploymentSpec} to the provisioner.
 * - the **provision box** (a trusted container running Alchemy 2) receives a
 *   {@link ProvisionJob} and answers {@link ProvisionEvent} lines.
 *
 * The manifest is `@lunora/config`'s own binding manifest — the same document
 * `lunora build --emit-bindings` writes — so the cloud never re-derives what an
 * app needs from `wrangler.jsonc` by hand.
 */
import type { BindingRequirement } from "@lunora/config/cloudflare";

export type { BindingRequirement } from "@lunora/config/cloudflare";

/** What the deploy request carries about the Worker's needs. */
export interface DeployManifest {
    /** Every binding the Worker reads off `env`, as `buildBindingManifest` lists them. */
    bindings: BindingRequirement[];
    /** `compatibility_date`; the platform default applies when absent. */
    compatibilityDate?: string;
    /** `compatibility_flags`; the platform default (`["nodejs_compat"]`) applies when absent. */
    compatibilityFlags?: string[];
}

/** One static file, keyed by its URL path (`/index.html`), content base64-encoded. */
export interface AssetFile {
    content: string;
    path: string;
}

/** The static files behind an `assets` binding, plus the subset of wrangler's `assets` config that changes serving. */
export interface AssetsUpload {
    config?: {
        html_handling?: "auto-trailing-slash" | "drop-trailing-slash" | "force-trailing-slash" | "none";
        not_found_handling?: "404-page" | "none" | "single-page-application";
        run_worker_first?: boolean | string[];
    };
    files: AssetFile[];
}

/**
 * How the platform satisfies each binding type.
 *
 * - `provisioned` — a per-project resource the platform creates (and names, see
 *   {@link tenantResourceName}) on first deploy, reuses across releases, and
 *   deletes only when the project's last deployment is torn down.
 * - `bound` — bound as-is with nothing to create (the class lives in the tenant
 *   bundle, or the binding is an account capability).
 * - `routed` — satisfied without a binding: queue consumers are drained by the
 *   control plane's consumer and forwarded to the tenant's `/_lunora/queue`,
 *   because a dispatch-namespace Worker cannot be a queue consumer.
 * - `unsupported` — refused at the deploy handler with the reason, before any
 *   resource is created. Never dropped silently: a missing binding surfaces as
 *   an undefined `env.X` at runtime, long after a green deploy.
 */
export const BINDING_SUPPORT = {
    ai: "bound",
    analytics_engine: "provisioned",
    assets: "bound",
    browser: "bound",
    container: "unsupported",
    d1: "provisioned",
    durable_object: "bound",
    hyperdrive: "unsupported",
    images: "bound",
    kv: "provisioned",
    pipeline: "unsupported",
    queue_consumer: "routed",
    queue_producer: "provisioned",
    r2: "provisioned",
    vectorize: "unsupported",
    workflow: "bound",
} as const satisfies Record<BindingRequirement["type"], "bound" | "provisioned" | "routed" | "unsupported">;

/** Why an `unsupported` type is refused — shown verbatim in the deploy error. */
export const UNSUPPORTED_REASONS: Record<Extract<keyof typeof BINDING_SUPPORT, "container" | "hyperdrive" | "pipeline" | "vectorize">, string> = {
    container: "containers need an image built and pushed per deploy, which Workers for Platforms cannot run",
    hyperdrive: "Hyperdrive points at your own database; bring-your-own origins are not supported on Lunora Cloud yet",
    pipeline: "a pipeline needs its stream and sink configured, which wrangler.jsonc does not carry",
    vectorize: "an index needs its dimensions and metric, which wrangler.jsonc does not carry",
};

/**
 * The account-unique name of a per-project resource.
 *
 * Keyed by the project alias (stable across releases) and the binding name, so
 * a re-deploy reuses the resource and a rollback sees the same data. Lowercased
 * and restricted to `[a-z0-9-]`, which every provisioned type accepts;
 * Analytics Engine datasets swap `-` for `_`, the only separator they allow.
 */
export const tenantResourceName = (alias: string, requirement: Pick<BindingRequirement, "binding" | "type">): string => {
    const name = `${alias}-${requirement.binding}`.toLowerCase().replaceAll(/[^a-z0-9-]/gu, "-");

    return requirement.type === "analytics_engine" ? name.replaceAll("-", "_") : name;
};

/** A single managed-tier release to converge. */
export interface TenantDeploymentSpec {
    /** The project's stable label (its public subdomain). Keys every per-project resource. */
    alias: string;
    assets?: AssetsUpload;
    /** Prebuilt Worker module (the app's own build output — never built here). */
    bundle: ArrayBuffer;
    /** Which cell (Cloudflare account) hosts this tenant. */
    cell: string;
    /** Dispatch namespace to deploy into (e.g. `lunora-production`). */
    dispatchNamespace: string;
    /** Validated: contains no `unsupported` type. */
    manifest: DeployManifest;
    /** The versioned, immutable per-release script id. */
    scriptName: string;
    /** Secrets for this release. Travel to the provision box as process env, never inside program source. */
    secrets: Record<string, string>;
    /** Lifecycle tags: `org:…`, `project:…`, `env:…`. */
    tags: string[];
    tailConsumers?: string[];
    /** Plain (non-secret) env vars, e.g. `LUNORA_OTLP_ENDPOINT`. */
    vars?: Record<string, string>;
}

/**
 * The job the control plane posts to the provision box at `POST /__lunora/provision`.
 *
 * Two Alchemy stacks per project, so releases are retained and pruned
 * independently while data outlives them:
 * - `lunora-project-<alias>` owns the `provisioned` resources.
 * - `lunora-release-<scriptName>` owns one release's Worker, referencing the
 *   project stack's resources. Destroying it never touches project data.
 */
export type ProvisionJob =
    | { action: "deploy"; spec: Omit<TenantDeploymentSpec, "bundle"> & { bundle: string } }
    | { action: "destroy"; alias: string; deleteProjectResources: boolean; dispatchNamespace: string; scriptName: string };

/** One NDJSON line of the provision box's reply. Exactly one `result` or `error` ends the stream. */
export type ProvisionEvent = { line: string; type: "log" } | { message: string; type: "error" } | { type: "result"; url?: string };
