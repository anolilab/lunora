/**
 * The provisioning contract, shared by the parties that meet at it:
 *
 * - the **CLI** (`lunora cloud deploy`) sends a {@link DeployManifest} and, when
 *   the app serves static files, an {@link AssetsUpload} in the `POST /v1/deploy`
 *   body. `packages/cli` cannot import this private app, so it mirrors these
 *   shapes in `src/util/cloud-client.ts` — change both together.
 * - the **deploy handler** validates that body against {@link BINDING_SUPPORT},
 *   refuses what the platform cannot provide, and hands a target-neutral
 *   {@link TenantDeploymentSpec} to the project's target driver
 *   (`src/targets/driver.ts`).
 * - each **driver** turns the spec into its own wire format — for
 *   `cloudflare-wfp`, a job for the Alchemy provision box
 *   (`src/targets/cloudflare-wfp/box-contract.ts`).
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
 * How a target satisfies one binding type.
 *
 * - `provisioned` — a per-project resource the target creates (named by
 *   `tenantResourceName`) on first deploy, reuses across releases, and deletes
 *   only when the project itself is torn down.
 * - `bound` — bound as-is with nothing to create (the class lives in the tenant
 *   bundle, or the binding is a capability of the host).
 * - `routed` — satisfied without a binding: the control plane delivers it on
 *   the tenant's behalf (WfP queue consumers, see `src/fanout/queue.ts`).
 * - `unsupported` — refused at the deploy handler with the target's reason,
 *   before any resource is created. Never dropped silently: a missing binding
 *   surfaces as an undefined `env.X` at runtime, long after a green deploy.
 */
export type BindingSupport = "bound" | "provisioned" | "routed" | "unsupported";

export type BindingType = BindingRequirement["type"];

/** One target's answer for every binding type `@lunora/config` can emit. */
export type BindingSupportTable = Readonly<Record<BindingType, BindingSupport>>;

/**
 * Every target a project can deploy to (`projects.target`, `deployments.target`).
 *
 * A target is a property of the PROJECT, not of the deploy request: `lunora
 * cloud deploy` sends the same body whatever it lands on. Each id has a binding
 * table below and, once it can converge, a driver in `src/targets/registry.ts`.
 */
export const TARGET_IDS = ["celld-vps", "cloudflare-wfp"] as const;

export type TargetId = (typeof TARGET_IDS)[number];

/** The target of every row that predates `projects.target` — Workers for Platforms, the only target that existed. */
export const DEFAULT_TARGET: TargetId = "cloudflare-wfp";

export const isTargetId = (value: unknown): value is TargetId => typeof value === "string" && (TARGET_IDS as ReadonlyArray<string>).includes(value);

export type DeployKind = "dev" | "preview" | "production";

/**
 * How each target satisfies each binding type ({@link BindingSupport}).
 *
 * Per target, because "what can Lunora Cloud run" has a different answer on
 * every host: the deploy handler validates a manifest against the table of the
 * PROJECT's target and refuses, by name, what that target cannot provide —
 * before a deployment row exists or anything is provisioned.
 */
export const BINDING_SUPPORT = {
    /**
     * A customer box running celld (plan 458), rated from celld's own capability
     * matrix (`@lunora/platform`'s `CELLD_CAPABILITIES`) — never looser than it,
     * and stricter only where `__tests__/binding-support.test.ts` lists why.
     * Queue consumers and crons are celld's own, not routed: celld delivers them.
     */
    "celld-vps": {
        ai: "unsupported",
        analytics_engine: "unsupported",
        artifacts: "unsupported",
        assets: "bound",
        browser: "unsupported",
        container: "unsupported",
        d1: "provisioned",
        durable_object: "bound",
        hyperdrive: "unsupported",
        images: "unsupported",
        kv: "provisioned",
        media: "unsupported",
        pipeline: "unsupported",
        queue_consumer: "bound",
        queue_producer: "provisioned",
        r2: "provisioned",
        stream: "unsupported",
        vectorize: "unsupported",
        vpc_network: "unsupported",
        vpc_service: "unsupported",
        workflow: "bound",
    },
    "cloudflare-wfp": {
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
        // A dispatch-namespace Worker cannot be a queue consumer: the control
        // plane's consumer drains the queue and forwards to `/_lunora/queue`.
        queue_consumer: "routed",
        queue_producer: "provisioned",
        r2: "provisioned",
        stream: "unsupported",
        vectorize: "unsupported",
        vpc_network: "unsupported",
        vpc_service: "unsupported",
        workflow: "unsupported",
    },
} as const satisfies Record<TargetId, BindingSupportTable>;

/** The binding types one target refuses. */
export type UnsupportedType<T extends TargetId> = {
    [K in keyof (typeof BINDING_SUPPORT)[T]]: (typeof BINDING_SUPPORT)[T][K] extends "unsupported" ? K : never;
}[keyof (typeof BINDING_SUPPORT)[T]];

/**
 * Why each target refuses each type it refuses — shown verbatim in the deploy
 * error, so each is worded for the host it describes.
 */
export const UNSUPPORTED_REASONS: { [T in TargetId]: Record<UnsupportedType<T>, string> } = {
    "celld-vps": {
        ai: "Workers AI is not a celld binding; call a model over fetch instead (celld routes `<provider>/<model>` through LUNORA_AI_PROXY_URL, not an env.AI binding)",
        analytics_engine: "Analytics Engine is not a celld binding type",
        artifacts: "an Artifacts namespace is a Cloudflare account resource with no celld equivalent",
        browser: "Browser Rendering is not a celld binding type",
        container: "celld runs containers only with Docker on the node, and Lunora Cloud keeps managed boxes Docker-free for now",
        hyperdrive: "Hyperdrive is not a celld binding type; connect to your database from an action instead",
        images: "the Images binding is not a celld binding type",
        media: "the Media Transformations binding is not a celld binding type",
        pipeline: "Pipelines is not a celld binding type",
        stream: "Stream is not a celld binding type",
        vectorize: "Vectorize is not a celld binding type",
        vpc_network: "a VPC network is a Cloudflare account resource with no celld equivalent",
        vpc_service: "a VPC service is a Cloudflare account resource with no celld equivalent",
    },
    "cloudflare-wfp": {
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
    },
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
 * A single managed-tier release to converge onto the project's one tenant.
 *
 * Target-neutral: where the tenant runs (a dispatch namespace in a cell, a box)
 * is the driver's business, not the spec's. A project has one stable tenant per
 * alias, updated in place by every deploy and every rollback, because a Durable
 * Object namespace belongs to the code that defines its class: a fresh tenant per
 * release would start every release on an empty `ShardDO`.
 */
export interface TenantDeploymentSpec {
    /** The project's stable label: its public hostname label and the key of every per-project resource. */
    alias: string;
    assets?: AssetsUpload;
    /** Prebuilt Worker module (the app's own build output — never built here). */
    bundle: ArrayBuffer;
    /** Wire the target's platform log source for this tenant (`TargetDriver.logs` in `src/targets/driver.ts`). Set when the release resolved telemetry. */
    collectLogs?: boolean;
    kind: DeployKind;
    /** Validated against the target's binding table: contains no `unsupported` type. */
    manifest: DeployManifest;
    /** Secrets for this release. Delivered by the driver, never inside program source. */
    secrets: Record<string, string>;
    /** Lifecycle tags: `org:…`, `project:…`, `env:…`. */
    tags: string[];
    /** Plain (non-secret) env vars, e.g. `LUNORA_OTLP_ENDPOINT`. */
    vars?: Record<string, string>;
}
