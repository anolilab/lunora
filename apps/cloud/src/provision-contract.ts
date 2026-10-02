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
 *   deletes only when the project itself is torn down.
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
    artifacts: "unsupported",
    assets: "bound",
    browser: "bound",
    container: "unsupported",
    d1: "provisioned",
    durable_object: "bound",
    hyperdrive: "unsupported",
    images: "bound",
    kv: "provisioned",
    media: "unsupported",
    pipeline: "unsupported",
    queue_consumer: "routed",
    queue_producer: "provisioned",
    r2: "provisioned",
    stream: "unsupported",
    vectorize: "unsupported",
    vpc_network: "unsupported",
    vpc_service: "unsupported",
    workflow: "unsupported",
} as const satisfies Record<BindingRequirement["type"], "bound" | "provisioned" | "routed" | "unsupported">;

/** Why an `unsupported` type is refused — shown verbatim in the deploy error. */
export const UNSUPPORTED_REASONS: Record<
    Extract<
        keyof typeof BINDING_SUPPORT,
        "artifacts" | "container" | "hyperdrive" | "media" | "pipeline" | "stream" | "vectorize" | "vpc_network" | "vpc_service" | "workflow"
    >,
    string
> = {
    artifacts: "an Artifacts namespace is an account resource the provision box does not create or bind yet",
    container: "containers need an image built and pushed per deploy, which Workers for Platforms cannot run",
    hyperdrive: "Hyperdrive points at your own database; bring-your-own origins are not supported on Lunora Cloud yet",
    media: "the Media Transformations binding is not bound to dispatch-namespace scripts yet",
    pipeline: "a pipeline needs its stream and sink configured, which wrangler.jsonc does not carry",
    stream: "a Stream binding is not bound to dispatch-namespace scripts yet",
    vectorize: "an index needs its dimensions and metric, which wrangler.jsonc does not carry",
    vpc_network: "a VPC network reaches into your own infrastructure; bring-your-own networks are not supported on Lunora Cloud yet",
    vpc_service: "a VPC service reaches into your own infrastructure; bring-your-own services are not supported on Lunora Cloud yet",
    workflow: "Workflows register per account script, and Workers for Platforms scripts have no such registration yet",
};

/**
 * A project alias: dash-separated runs of `[a-z0-9]`, so it never contains `--`
 * and never starts or ends with `-`. That is what makes {@link tenantResourceName}
 * injective — the first `--` in a resource name is always the separator.
 */
export const ALIAS_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

/** Cloudflare's tightest name limit across the provisioned types (R2 buckets, queues). */
const MAX_RESOURCE_NAME = 63;

/**
 * The account-unique name of a per-project resource: `{alias}--{binding}`.
 *
 * Keyed by the project alias (stable across releases) and the binding name, so
 * a re-deploy reuses the resource and a rollback sees the same data. The binding
 * is lowercased with `_` → `-` (binding names are `[A-Za-z_]\w*`, so this only
 * folds case — the handler refuses bindings that differ only in case). Analytics
 * Engine datasets swap `-` for `_`, the only separator they allow.
 *
 * Injective because an alias never contains `--`: two different tenants can never
 * be handed the same database. A single `-` separator was not — alias `app` +
 * binding `B_DB` and alias `app-b` + binding `DB` both named `app-b-db`.
 * @throws when the alias is malformed or the name exceeds 63 characters.
 */
export const tenantResourceName = (alias: string, requirement: Pick<BindingRequirement, "binding" | "type">): string => {
    if (!ALIAS_PATTERN.test(alias)) {
        throw new Error(`alias "${alias}" must match ${String(ALIAS_PATTERN)}`);
    }

    const name = `${alias}--${requirement.binding.toLowerCase().replaceAll("_", "-")}`;

    if (name.length > MAX_RESOURCE_NAME) {
        throw new Error(`resource name "${name}" exceeds ${String(MAX_RESOURCE_NAME)} characters; shorten the project name or binding ${requirement.binding}`);
    }

    return requirement.type === "analytics_engine" ? name.replaceAll("-", "_") : name;
};

/** The alias a {@link tenantResourceName} (non-Analytics-Engine) belongs to, or `undefined` for a name it did not produce. */
export const aliasOfResourceName = (name: string): string | undefined => {
    const separator = name.indexOf("--");
    const alias = separator === -1 ? "" : name.slice(0, separator);

    return ALIAS_PATTERN.test(alias) && separator + 2 < name.length ? alias : undefined;
};

/**
 * A single managed-tier release to converge onto the project's stable Worker.
 *
 * There is one dispatch-namespace script per project per namespace, and its
 * name IS the alias. Every deploy (and every rollback) updates that script in
 * place, because a Durable Object namespace belongs to the script that defines
 * its class: a new script per release would start every release on an empty
 * `ShardDO`. Workers for Platforms has no Worker Versions or gradual deployments
 * for user Workers, so "many releases on one script" is not available either.
 */
export interface TenantDeploymentSpec {
    /** The project's stable label: its public subdomain, its dispatch-namespace script name, and the key of every per-project resource. */
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
    /** Secrets for this release. Travel to the provision box as process env, never inside program source. */
    secrets: Record<string, string>;
    /** Lifecycle tags: `org:…`, `project:…`, `env:…`. */
    tags: string[];
    tailConsumers?: string[];
    /** Plain (non-secret) env vars, e.g. `LUNORA_OTLP_ENDPOINT`. */
    vars?: Record<string, string>;
}

/**
 * A binding as the box receives it. Provisioned types carry the name the control
 * plane computed with {@link tenantResourceName}: the box is plain JavaScript and
 * never re-derives it, so the naming rule lives in exactly one place.
 */
export type ProvisionBinding = BindingRequirement & { resourceName?: string };

/**
 * The job the control plane posts to the provision box at `POST /__lunora/provision`.
 *
 * Two Alchemy stacks per project, both keyed by the alias:
 * - `lunora-project-{alias}` owns the `provisioned` resources.
 * - `lunora-worker-{alias}` owns the project's one Worker (script name = alias),
 *   bound to the project stack's resources. Every deploy converges it in place,
 *   so its Durable Object storage outlives releases.
 *
 * Releases are not scripts: each one is a stored bundle the control plane keeps
 * (`src/deploy/release-store.ts`), and a rollback is a `deploy` job carrying an
 * older bundle. So `destroy` only ever means the project is gone — it removes the
 * Worker, then the project stack and its data.
 */
export type ProvisionJob =
    | {
          action: "deploy";
          spec: Omit<TenantDeploymentSpec, "bundle" | "manifest"> & {
              bundle: string;
              manifest: Omit<DeployManifest, "bindings"> & { bindings: ProvisionBinding[] };
          };
      }
    | { action: "destroy"; alias: string; dispatchNamespace: string };

/** One NDJSON line of the provision box's reply. Exactly one `result` or `error` ends the stream. */
export type ProvisionEvent = { line: string; type: "log" } | { message: string; type: "error" } | { type: "result"; url?: string };
