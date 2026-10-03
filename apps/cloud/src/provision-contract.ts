/**
 * The provisioning contract, shared by the parties that meet at it:
 *
 * - the **CLI** (`lunora cloud deploy`) sends a {@link DeployManifest} and, when
 *   the app serves static files, an {@link AssetsUpload} in the `POST /v1/deploy`
 *   body. `packages/cli` cannot import this private app, so it mirrors these
 *   shapes in `src/util/cloud-client.ts` — change both together.
 * - the **deploy core** validates that body against {@link BINDING_SUPPORT},
 *   refuses what the platform cannot provide, and hands a target-neutral
 *   {@link TenantDeploymentSpec} to the project's target driver
 *   (`src/targets/driver.ts`).
 * - each **driver** turns the spec into its own wire format — for the two
 *   Cloudflare targets, a job for the Alchemy provision box
 *   (`src/targets/provision-box/contract.ts`).
 *
 * The manifest is `@lunora/config`'s own binding manifest — the same document
 * `lunora build --emit-bindings` writes — so the cloud never re-derives what an
 * app needs from `wrangler.jsonc` by hand.
 */
import type { CelldReleaseBindings } from "@lunora/config/celld";
import { CELLD_RELEASE_BINDINGS, isReleaseAlias, releaseResourceName } from "@lunora/config/celld";
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

/**
 * The static files behind an `assets` binding, plus the subset of wrangler's `assets` config that changes serving.
 *
 * `_headers` / `_redirects` are the raw contents of those files at the app's
 * assets root — never among `files`. Like wrangler, the upload carries them as
 * config: Cloudflare's script-upload `metadata.assets.config` takes fields of
 * the same names, and every target applies their rules to static responses.
 */
export interface AssetsUpload {
    config?: {
        _headers?: string;
        _redirects?: string;
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
 * Every target a project can deploy to (`projects.target`, `deployments.target`),
 * the default first, in the order the studio lists them.
 *
 * A target is a property of the PROJECT, not of the deploy request: `lunora
 * cloud deploy` sends the same body whatever it lands on. Each id has a
 * descriptor ({@link TARGETS}), a binding table below and, once it can
 * converge, a driver in `src/targets/registry.ts`.
 */
export const TARGET_IDS = ["cloudflare-wfp", "cloudflare-workers", "celld-vps"] as const;

export type TargetId = (typeof TARGET_IDS)[number];

/** The target of every row that predates `projects.target` — Workers for Platforms, the only target that existed. */
export const DEFAULT_TARGET: TargetId = "cloudflare-wfp";

export const isTargetId = (value: unknown): value is TargetId => typeof value === "string" && (TARGET_IDS as ReadonlyArray<string>).includes(value);

/**
 * A stored `target` column → its id, or `undefined` for a value no target
 * answers to. Absent (`undefined`, or SQL NULL off a `.global()` row) means the
 * row predates targets, and is {@link DEFAULT_TARGET}.
 */
export const storedTarget = (stored: null | string | undefined): TargetId | undefined => {
    if (stored == null) {
        return DEFAULT_TARGET;
    }

    return isTargetId(stored) ? stored : undefined;
};

/** A capability a target lacks as a whole (not a binding), with the reason the studio shows. */
export interface TargetLimitation {
    id: "customDomains" | "logs" | "pitr" | "runtimeLimits";
    label: string;
    reason: string;
}

/** celld's `pointInTimeRecovery` capability note, verbatim (`__tests__/target-capabilities.test.ts` pins it to `@lunora/platform`). */
export const CELLD_PITR_NOTE =
    "celld's Durable Object storage has no bookmark API (`getBookmarkForTime` / `onNextSessionRestoreBookmark`), so getPitrBookmark / pitrRestore answer PITR_UNAVAILABLE. The fleet bucket's epoch-fenced replication is for durability and takeover, not an addressable history; `lunora backup` (objectStorageBackups) is the recovery tier here";

/** What every part of the control plane and the studio knows about a target without building its driver. */
export interface TargetDescriptor {
    /** The studio's one-line description of the target. */
    description: string;

    /**
     * Whether a converge deletes the data of a Durable Object class the release
     * no longer binds. True on Workers for Platforms: Alchemy emits
     * `deleted_classes` for a class a dispatch-namespace Worker stops binding, so
     * a rollback to a release that predates a class is refused (`reprovision`).
     */
    dropsUnboundClasses: boolean;

    /**
     * Who fires tenant crons and drains tenant queues. `dispatcher` — the
     * control plane does, over the driver's `dispatch`, because the target cannot
     * (WfP drops `triggers.crons` for namespaced Workers, and a namespaced Worker
     * cannot be a queue consumer; `src/fanout/*`). `native` — the target runs
     * them itself and the fan-out skips its deployments.
     */
    fanout: "dispatcher" | "native";
    /** The studio's name for the target. */
    label: string;
    /** What the target lacks beyond its bindings, as the studio states it (plan 458 W9). */
    limitations: ReadonlyArray<TargetLimitation>;

    /**
     * How request counts reach the `platformUsage` ledger. `readback` — the
     * hourly sweep pulls them through the driver's `usage`. `pushed` — the
     * target reports them itself (a box's `report` frames) and the sweep does
     * not poll.
     */
    metering: "pushed" | "readback";

    /**
     * Where a project of this target is placed. `cell` — in its organization's
     * cell (one Cloudflare account, one dispatch namespace, one control plane).
     * `box` — on a machine its organization enrolled. `account` — in a
     * Cloudflare account its organization connected, converged by its
     * organization's cell, whose provision box holds the convergence state. A
     * box or an account is the host row `projects.placementRef` names; which
     * table that is, and how every layer reads it, is `PLACEMENT_HOSTS` in
     * `src/targets/placement.ts`. It also decides whose budget a converge
     * spends (`src/deploy/pacing.ts`): the cell's account, the connected
     * account — Alchemy runs in the cell's provision box, but every API call
     * it makes goes there — or the box's session alone.
     */
    placedOn: "account" | "box" | "cell";
}

/** Every target's descriptor — the one place "does this target need a box", its name and its limits are decided. */
export const TARGETS = {
    "celld-vps": {
        description: "Runs on celld on a Linux server your organization enrolled. Its data stays in your own bucket.",
        dropsUnboundClasses: false,
        fanout: "native",
        label: "Your own server",
        // No per-plan runtime limits (the dispatcher applies those, and there is
        // no dispatcher in front of a box) and no point-in-time recovery.
        limitations: [
            {
                id: "runtimeLimits",
                label: "Per-plan runtime limits",
                reason: "The CPU-time and subrequest caps your plan sets are applied by Lunora Cloud's dispatcher, which does not sit in front of your server. A request there is bounded by the machine's memory and celld's 128 MB isolate heap instead.",
            },
            { id: "pitr", label: "Point-in-time recovery", reason: CELLD_PITR_NOTE },
        ],
        metering: "pushed",
        placedOn: "box",
    },
    "cloudflare-wfp": {
        description: "Runs on Cloudflare's network, managed end to end by Lunora Cloud.",
        dropsUnboundClasses: true,
        fanout: "dispatcher",
        label: "Lunora Cloud (Cloudflare)",
        limitations: [],
        metering: "readback",
        placedOn: "cell",
    },
    "cloudflare-workers": {
        description:
            "Runs as a plain Worker in a Cloudflare account your organization connected. Its data stays in that account, and Cloudflare bills you for it directly.",
        // Alchemy emits `deleted_classes` for a class any Worker it manages stops binding.
        dropsUnboundClasses: true,
        // A plain Worker carries its own `triggers.crons` and is its own queue consumer.
        fanout: "native",
        label: "Your Cloudflare account",
        limitations: [
            {
                id: "runtimeLimits",
                label: "Per-plan runtime limits",
                reason: "The CPU-time and subrequest caps your plan sets are applied by Lunora Cloud's dispatcher, which does not sit in front of a Worker in your account. Your account's own Workers limits apply instead.",
            },
            {
                id: "customDomains",
                label: "Custom domains",
                reason: "Your Worker answers on your account's workers.dev subdomain. Attaching your own zone's hostnames to it from Lunora Cloud is not wired yet; add a Custom Domain to the Worker in your Cloudflare dashboard meanwhile.",
            },
            {
                id: "logs",
                label: "Runtime logs",
                reason: "Lunora Cloud's tail consumer runs in its own account and cannot be attached to a Worker in yours, so runtime logs stay in your account's Workers Logs.",
            },
        ],
        // Request counts are read back from the account's GraphQL Analytics API, and shown, never billed.
        metering: "readback",
        placedOn: "account",
    },
} as const satisfies Record<TargetId, TargetDescriptor>;

/**
 * The permissions a `cloudflare-workers` account token needs, least-privilege
 * (account-scoped, on the connected account only). Edit on each resource type
 * because the provision box creates the resources; only Workers Scripts is
 * required — the rest are needed once an app binds that type. Zone → Workers
 * Routes: Edit is deliberately absent: it is only needed for custom routes on
 * the customer's zone, which the target does not wire yet. Shared by the
 * connect route's probes (`src/targets/cloudflare-workers/api.ts`) and the
 * studio's instructions, so both name the same list.
 */
export const CLOUDFLARE_TOKEN_PERMISSIONS = {
    analytics: { label: "Account Analytics: Read", required: false, use: "request counts for the Usage tab" },
    billing: { label: "Billing: Read", required: false, use: "the account's real spend on the Cloudflare costs tab (self-serve accounts only)" },
    d1: { label: "D1: Edit", required: false, use: "d1 bindings" },
    kv: { label: "Workers KV Storage: Edit", required: false, use: "kv bindings" },
    queues: { label: "Queues: Edit", required: false, use: "queue bindings" },
    r2: { label: "Workers R2 Storage: Edit", required: false, use: "r2 bindings" },
    workersScripts: {
        label: "Workers Scripts: Edit",
        required: true,
        use: "uploading the Worker, its cron triggers and queue consumers, and reading the workers.dev subdomain",
    },
} as const satisfies Record<string, { label: string; required: boolean; use: string }>;

export type CloudflarePermission = keyof typeof CLOUDFLARE_TOKEN_PERMISSIONS;

/** The targets whose projects are placed on a box. */
export type BoxTargetId = { [T in TargetId]: (typeof TARGETS)[T]["placedOn"] extends "box" ? T : never }[TargetId];

/** The targets whose projects are placed in a Cloudflare account their organization connected. */
export type AccountTargetId = { [T in TargetId]: (typeof TARGETS)[T]["placedOn"] extends "account" ? T : never }[TargetId];

/** The targets whose projects are placed in their organization's cell. */
export type CellTargetId = Exclude<TargetId, AccountTargetId | BoxTargetId>;

export type DeployKind = "dev" | "preview" | "production";

/** Why `celld-vps` refuses each binding type celld does not run — exactly those, or this fails to compile. */
const CELLD_VPS_REFUSALS: Readonly<Record<Exclude<BindingType, keyof CelldReleaseBindings>, string>> = {
    ai_search: "AI Search is not a celld binding type",
    ai_search_namespace: "an AI Search namespace is a Cloudflare account resource with no celld equivalent",
    ai: "Workers AI is not a celld binding; call a model over fetch instead (celld routes `<provider>/<model>` through LUNORA_AI_PROXY_URL, not an env.AI binding)",
    analytics_engine: "Analytics Engine is not a celld binding type",
    analytics_sql: "the Analytics SQL binding queries Cloudflare's analytics, which a celld fleet has no equivalent of",
    artifacts: "an Artifacts namespace is a Cloudflare account resource with no celld equivalent",
    browser: "Browser Rendering is not a celld binding type",
    container: "celld runs containers only with Docker on the node, and Lunora Cloud keeps managed boxes Docker-free for now",
    hyperdrive: "Hyperdrive is not a celld binding type; connect to your database from an action instead",
    images: "the Images binding is not a celld binding type",
    media: "the Media Transformations binding is not a celld binding type",
    pipeline: "Pipelines is not a celld binding type",
    service: "a service binding needs its sibling Worker in the same celld fleet, and a box runs one fleet per project",
    stream: "Stream is not a celld binding type",
    vectorize: "Vectorize is not a celld binding type",
    vpc_network: "a VPC network is a Cloudflare account resource with no celld equivalent",
    vpc_service: "a VPC service is a Cloudflare account resource with no celld equivalent",
};

/** The `celld-vps` binding row: celld's own map, every other type `unsupported`. */
type CelldVpsSupport = { readonly [K in BindingType]: K extends keyof CelldReleaseBindings ? CelldReleaseBindings[K] : "unsupported" };

/**
 * {@link CelldVpsSupport} as a value. Built rather than spelled out, so the
 * box's celld config ({@link CELLD_RELEASE_BINDINGS}) is the one list; the cast
 * restates the spread in the mapped type TypeScript cannot follow it into.
 */
const CELLD_VPS_SUPPORT = {
    ...Object.fromEntries(Object.keys(CELLD_VPS_REFUSALS).map((type) => [type, "unsupported"])),
    ...CELLD_RELEASE_BINDINGS,
} as CelldVpsSupport;

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
     * A customer box running celld (plan 458): exactly what the box's own celld
     * config runs (`CELLD_RELEASE_BINDINGS` in `@lunora/config/celld`, which
     * also says what is provisioned), every other type refused with its reason
     * in {@link UNSUPPORTED_REASONS}. Never looser than celld's capability
     * matrix (`@lunora/platform`'s `CELLD_CAPABILITIES`), stricter only where
     * `__tests__/binding-support.test.ts` lists why. Queue consumers and crons
     * are celld's own, not routed: celld delivers them.
     */
    "celld-vps": CELLD_VPS_SUPPORT,
    "cloudflare-wfp": {
        ai: "bound",
        ai_search: "unsupported",
        ai_search_namespace: "unsupported",
        analytics_engine: "provisioned",
        analytics_sql: "unsupported",
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
        service: "unsupported",
        stream: "unsupported",
        vectorize: "unsupported",
        vpc_network: "unsupported",
        vpc_service: "unsupported",
        workflow: "unsupported",
    },

    /**
     * A plain Worker in the customer's own account (MULTIPLATFORM.md Phase 3):
     * the same provision box and Alchemy program as `cloudflare-wfp`, minus the
     * dispatch namespace — so queue consumers are the Worker's own, not routed.
     * Everything else is held to what that program creates or binds today;
     * a type a plain Worker could take but the program does not wire is refused
     * with that reason, never bound half-way.
     */
    "cloudflare-workers": {
        ai: "bound",
        ai_search: "unsupported",
        ai_search_namespace: "unsupported",
        analytics_engine: "provisioned",
        analytics_sql: "unsupported",
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
        queue_consumer: "bound",
        queue_producer: "provisioned",
        r2: "provisioned",
        service: "unsupported",
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
    "celld-vps": CELLD_VPS_REFUSALS,
    "cloudflare-wfp": {
        ai_search: "an AI Search instance is an account resource the provision box does not create or bind yet",
        ai_search_namespace: "an AI Search namespace is an account resource the provision box does not create or bind yet",
        analytics_sql: "the provision box does not bind Analytics SQL to dispatch-namespace scripts yet",
        artifacts: "an Artifacts namespace is an account resource the provision box does not create or bind yet",
        container: "containers need an image built and pushed per deploy, which Workers for Platforms cannot run",
        hyperdrive: "Hyperdrive points at your own database; bring-your-own origins are not supported on Lunora Cloud yet",
        media: "the Media Transformations binding is not bound to dispatch-namespace scripts yet",
        pipeline: "a pipeline needs its stream and sink configured, which wrangler.jsonc does not carry",
        service: "a service binding needs its sibling Worker deployed alongside, which a project's deploy does not ship yet",
        stream: "a Stream binding is not bound to dispatch-namespace scripts yet",
        vectorize: "an index needs its dimensions and metric, which wrangler.jsonc does not carry",
        vpc_network: "a VPC network reaches into your own infrastructure; bring-your-own networks are not supported on Lunora Cloud yet",
        vpc_service: "a VPC service reaches into your own infrastructure; bring-your-own services are not supported on Lunora Cloud yet",
        workflow: "Workflows register per account script, and Workers for Platforms scripts have no such registration yet",
    },
    "cloudflare-workers": {
        ai_search: "the provision box does not bind an AI Search instance yet",
        ai_search_namespace: "the provision box does not bind an AI Search namespace yet",
        analytics_sql: "the provision box does not bind Analytics SQL yet",
        artifacts: "an Artifacts namespace is an account resource the provision box does not create or bind yet",
        container: "a container needs its image built and pushed to your account's registry on every deploy, which the provision box does not do yet",
        hyperdrive:
            "a Hyperdrive config needs your database's connection string, which the binding manifest does not carry; connect to it from an action instead",
        media: "the provision box does not bind Media Transformations yet",
        pipeline: "a pipeline needs its stream and sink configured, which wrangler.jsonc does not carry",
        service: "a service binding needs its sibling Worker deployed alongside, which a project's deploy does not ship yet",
        stream: "the provision box does not bind Stream yet",
        vectorize: "an index needs its dimensions and metric, which wrangler.jsonc does not carry",
        vpc_network: "the provision box does not bind a VPC network yet",
        vpc_service: "the provision box does not bind a VPC service yet",
        workflow: "a plain Worker can run Workflows, but the provision box does not register a prebuilt bundle's Workflow class yet",
    },
};

/** Why `target` refuses binding type `type`, worded for that host, or `undefined` when it does not refuse it. */
export const unsupportedReason = (target: TargetId, type: BindingType): string | undefined =>
    (UNSUPPORTED_REASONS[target] as Readonly<Partial<Record<BindingType, string>>>)[type];

/**
 * The account-unique name of a per-project resource: `{alias}--{binding}`
 * (`releaseResourceName` in `@lunora/config/celld`, the one implementation the
 * box's celld config uses too).
 *
 * Keyed by the project alias (stable across releases) and the binding name, so
 * a re-deploy reuses the resource and a rollback sees the same data, and a
 * project moved between targets keeps its names. Injective because an alias
 * never contains `--`. The one thing added here: Analytics Engine datasets
 * swap `-` for `_`, the only separator they allow.
 * @throws when the alias is malformed or the name exceeds 63 characters.
 */
export const tenantResourceName = (alias: string, requirement: Pick<BindingRequirement, "binding" | "type">): string => {
    const name = releaseResourceName(alias, requirement.binding);

    return requirement.type === "analytics_engine" ? name.replaceAll("-", "_") : name;
};

/** The alias a {@link tenantResourceName} (non-Analytics-Engine) belongs to, or `undefined` for a name it did not produce. */
export const aliasOfResourceName = (name: string): string | undefined => {
    const separator = name.indexOf("--");
    const alias = separator === -1 ? "" : name.slice(0, separator);

    return isReleaseAlias(alias) && separator + 2 < name.length ? alias : undefined;
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
    /** Wire the target's platform log source for this tenant (`cloudflare-wfp`: the tail consumer). Set when the release resolved telemetry. */
    collectLogs?: boolean;

    /**
     * The tenant's cron expressions (wrangler `triggers.crons`), for a target
     * that fires them itself (`celld-vps`, plan 458 D11). A `dispatcher` target
     * ignores them: the control plane fans its ticks out from `deployments.cronSpecs`.
     */
    crons?: string[];
    /** The deployment this spec releases — the key of its stored release in `RELEASES`, which a box fetches it by (plan 458 D6). */
    deploymentId: string;
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
