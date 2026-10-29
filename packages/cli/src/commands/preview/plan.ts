/**
 * What an isolated preview of the app is, computed from the committed wrangler config alone: its names, the
 * resources it owns, the `env.<preview>` block it deploys with, and the reasons it cannot be made yet.
 *
 * The block is built from an allowlist. Wrangler bindings do not inherit into an environment, so a binding the
 * block leaves out is simply absent from the preview; one it copies keeps pointing wherever production's does.
 * Only kinds with no production state behind them are copied, the D1, KV and R2 kinds get preview-owned
 * resources, and any other key stops the preview: copying an unknown binding is how a preview would write to
 * production.
 */
import type { WranglerConfig } from "@lunora/config/cloudflare";

import boundedName from "../../util/bounded-name";

/** The config a preview is planned from; `name` is read here, so it is part of the shape. */
type PreviewConfig = WranglerConfig & { env?: Record<string, PreviewConfig>; name?: unknown };

/** Cloudflare's limit for a Worker name (it is a workers.dev DNS label), an R2 bucket name, and the D1 names we make. */
const NAME_LIMIT = 63;

type PreviewResourceKind = "d1" | "kv" | "r2";

/** A resource the preview owns, by the binding it backs. */
interface PlannedResource {
    binding: string;
    kind: PreviewResourceKind;
    name: string;
}

interface PreviewPlan {
    /** The `env.<name>` key the preview deploys under. */
    environment: string;
    /** The production Worker's name, which the preview's names are derived from. */
    production: string;
    resources: PlannedResource[];
    /** The preview's name in Cloudflare's alphabet. */
    slug: string;
    /** The preview Worker's name: its own Durable Object namespace. */
    worker: string;
}

/** Keys that configure the Worker but bind no account resource. Inheritable ones reach the preview as they are. */
const SETTINGS_KEYS = new Set([
    "$schema",
    "account_id",
    "alias",
    "assets",
    "base_dir",
    "build",
    "cache",
    "compatibility_date",
    "compatibility_flags",
    "dev",
    "env",
    "find_additional_modules",
    "jsx_factory",
    "jsx_fragment",
    "keep_names",
    "keep_vars",
    "limits",
    "logpush",
    "main",
    "migrations",
    "minify",
    "name",
    "no_bundle",
    "observability",
    "placement",
    "preview_urls",
    "routes",
    "rules",
    "send_metrics",
    "triggers",
    "tsconfig",
    "upload_source_maps",
    "workers_dev",
]);

/**
 * Non-inheritable keys copied into the preview unchanged: each binds a capability, not production data
 * (`vars` and `secrets` are the config's own values and secret names, `define` its build-time constants).
 */
const COPIED_KEYS = ["ai", "browser", "define", "images", "media", "secrets", "send_email", "vars", "version_metadata", "worker_loaders"] as const;

/** Non-inheritable keys left out: a preview's logs do not go to production's tail Workers. */
const DROPPED_KEYS = new Set(["tail_consumers"]);

const ISOLATED_KEYS = { d1_databases: "d1", kv_namespaces: "kv", r2_buckets: "r2" } as const satisfies Record<string, PreviewResourceKind>;

const isPresent = (value: unknown): boolean => {
    if (value === undefined || value === null) {
        return false;
    }

    if (Array.isArray(value)) {
        return value.length > 0;
    }

    return typeof value !== "object" || Object.keys(value).length > 0;
};

type Entry = Record<string, unknown>;

const entriesOf = (value: unknown): Entry[] =>
    (Array.isArray(value) ? (value as unknown[]) : []).filter((entry): entry is Entry => typeof entry === "object" && entry !== null);

/** Why a key stops the preview, or `undefined` when the plan can carry it. */
const refusalFor = (key: string, value: unknown): string | undefined => {
    if (SETTINGS_KEYS.has(key) || DROPPED_KEYS.has(key) || (COPIED_KEYS as ReadonlyArray<string>).includes(key) || key in ISOLATED_KEYS) {
        return undefined;
    }

    if (key === "route") {
        return '"route": write it as "routes" so the preview can clear it — a preview must never claim production\'s hostname';
    }

    if (key === "durable_objects") {
        const external = entriesOf((value as { bindings?: unknown }).bindings).find((entry) => entry.script_name !== undefined);

        return external === undefined
            ? undefined
            : `"durable_objects": the "${String(external.name)}" binding reaches another Worker's Durable Objects (script_name "${String(external.script_name)}"), which the preview would share`;
    }

    if (key === "exports") {
        const workflow = Object.entries(value as Record<string, { type?: unknown } | null>).find(([, entry]) => entry?.type === "workflow");

        return workflow === undefined
            ? undefined
            : `"exports": workflow "${workflow[0]}" has an account-wide name, so the preview would take over production's workflow`;
    }

    return `"${key}": a preview cannot isolate this binding yet, and copying it would point the preview at production's resource`;
};

/** The plain-text var every preview Worker carries: `<production>/<slug>`. */
const PREVIEW_MARKER_VAR = "LUNORA_PREVIEW";

const previewMarker = (names: Pick<PreviewPlan, "production" | "slug">): string => `${names.production}/${names.slug}`;

const NON_SLUG_CHARACTERS = /[^a-z0-9]+/u;

/** The preview's name in Cloudflare's alphabet: lowercase letters, digits and single dashes. */
const previewSlug = (name: string): string =>
    name
        .toLowerCase()
        .split(NON_SLUG_CHARACTERS)
        .filter((part) => part !== "")
        .join("-");

type PreviewNames = Pick<PreviewPlan, "environment" | "production" | "slug" | "worker">;

/** The names a preview of `config` called `name` gets, or why it cannot be named. Delete derives them too, so they never depend on the bindings. */
const previewNames = (config: PreviewConfig, name: string): { error: string; names?: never } | { error?: never; names: PreviewNames } => {
    const production = typeof config.name === "string" ? config.name : "";
    const slug = previewSlug(name);

    if (production === "") {
        return { error: 'wrangler.jsonc has no "name", which the preview Worker\'s name is derived from' };
    }

    if (slug === "") {
        return { error: `"${name}" has no letter or digit to name a preview by` };
    }

    return {
        names: { environment: boundedName(`preview-${slug}`, NAME_LIMIT), production, slug, worker: boundedName(`${production}-preview-${slug}`, NAME_LIMIT) },
    };
};

/**
 * Whether `env.<key>` is the block a preview run of `config` wrote: its key, Worker name and marker are all the
 * ones the slug in its marker derives. Any other block, marked or not, is one of the user's environments.
 */
const isPreviewBlock = (config: PreviewConfig, key: string, block: PreviewConfig | undefined): boolean => {
    const marker = block?.vars?.[PREVIEW_MARKER_VAR];
    const production = typeof config.name === "string" ? config.name : "";

    if (typeof marker !== "string" || production === "" || !marker.startsWith(`${production}/`)) {
        return false;
    }

    const { names } = previewNames(config, marker.slice(production.length + 1));

    return names !== undefined && previewMarker(names) === marker && names.environment === key && block?.name === names.worker;
};

/** The name of the resource a preview Worker owns for `binding`. */
const previewResourceName = (worker: string, binding: string): string => boundedName(`${worker}-${binding}`, NAME_LIMIT);

/** The plan for previewing `config` as `name`, or why it cannot be made. Pure: reads nothing, writes nothing. */
const planPreview = (config: PreviewConfig, name: string): { error: string; plan?: never } | { error?: never; plan: PreviewPlan } => {
    const named = previewNames(config, name);

    if (named.error !== undefined) {
        return { error: named.error };
    }

    const { environment, worker } = named.names;

    // A block this command wrote and an interrupted run left behind is overwritten; any other is the user's.
    if (config.env?.[environment] !== undefined && !isPreviewBlock(config, environment, config.env[environment])) {
        return { error: `wrangler.jsonc already declares "env.${environment}"; a preview writes that block itself, so name the preview differently` };
    }

    const refusals = Object.entries(config as Record<string, unknown>).flatMap(([key, value]) => {
        const refusal = isPresent(value) ? refusalFor(key, value) : undefined;

        return refusal === undefined ? [] : [refusal];
    });
    const jurisdictional = entriesOf(config.r2_buckets).find((entry) => entry.jurisdiction !== undefined);

    if (jurisdictional !== undefined) {
        refusals.push(`"r2_buckets": the "${String(jurisdictional.binding)}" bucket has a jurisdiction, which a preview bucket is not created in yet`);
    }

    if (refusals.length > 0) {
        return { error: `this app cannot be previewed in isolation yet:\n  - ${refusals.join("\n  - ")}` };
    }

    const resources = Object.entries(ISOLATED_KEYS).flatMap(([key, kind]) =>
        entriesOf((config as Record<string, unknown>)[key]).map((entry) => {
            const binding = String(entry.binding);

            return { binding, kind, name: previewResourceName(worker, binding) };
        }),
    );

    return { plan: { ...named.names, resources } };
};

/** The id each planned resource was given in the account (an R2 bucket's id is its name), keyed by `<kind>:<binding>`. */
type ResourceIds = ReadonlyMap<string, string>;

const resourceKey = (kind: PreviewResourceKind, binding: string): string => `${kind}:${binding}`;

const without = (entry: Entry, key: string): Entry => Object.fromEntries(Object.entries(entry).filter(([name]) => name !== key));

/** Rewrite one isolated binding onto its preview resource. Preview/dev-only ids name production's dev resources, so they go. */
const isolatedEntry = (kind: PreviewResourceKind, entry: Entry, plan: PreviewPlan, ids: ResourceIds): Entry => {
    const binding = String(entry.binding);
    const planned = plan.resources.find((resource) => resource.kind === kind && resource.binding === binding);
    const id = ids.get(resourceKey(kind, binding));

    if (planned === undefined || id === undefined) {
        throw new Error(`no preview ${kind} resource for the "${binding}" binding`);
    }

    if (kind === "d1") {
        return { ...without(entry, "preview_database_id"), database_id: id, database_name: planned.name };
    }

    return kind === "kv" ? { ...without(entry, "preview_id"), id } : { ...without(entry, "preview_bucket_name"), bucket_name: id };
};

/**
 * The `env.<preview>` block. `routes: []` overrides production's inheritable routes and custom domains, empty
 * `triggers` keep production's crons from firing once per open preview, and `workers_dev` gives the preview its URL; `name` is set so wrangler's `<name>-<env>` default never applies.
 */
const previewEnvironmentBlock = (config: PreviewConfig, plan: PreviewPlan, ids: ResourceIds, overrides: Readonly<Record<string, string>> = {}): Entry => {
    const source = config as Record<string, unknown>;
    const block: Entry = { name: plan.worker, routes: [], triggers: { crons: [] }, workers_dev: true };
    const marker = { [PREVIEW_MARKER_VAR]: previewMarker(plan) };

    for (const key of COPIED_KEYS) {
        if (isPresent(source[key])) {
            block[key] = source[key];
        }
    }

    // `--var` overrides production values a preview must not keep (an auth base URL, a CORS origin). The marker
    // goes last and is deployed with the Worker, so `delete` can tell a Worker this command made from one that
    // merely has its name.
    block.vars = { ...(isPresent(config.vars) ? config.vars : {}), ...overrides, ...marker };

    if (isPresent(config.durable_objects)) {
        block.durable_objects = config.durable_objects;
    }

    for (const [key, kind] of Object.entries(ISOLATED_KEYS)) {
        const entries = entriesOf(source[key]);

        if (entries.length > 0) {
            block[key] = entries.map((entry) => isolatedEntry(kind, entry, plan, ids));
        }
    }

    return block;
};

const IDENTITY_FIELDS: Record<string, ReadonlyArray<string>> = {
    analytics_engine_datasets: ["dataset"],
    d1_databases: ["database_id", "database_name", "preview_database_id"],
    hyperdrive: ["id"],
    kv_namespaces: ["id", "preview_id"],
    r2_buckets: ["bucket_name", "preview_bucket_name"],
    vectorize: ["index_name"],
};

/** The resource identities and Worker name one config block points at. */
const identitiesOf = (block: Record<string, unknown>): string[] => {
    const fieldValues = Object.entries(IDENTITY_FIELDS).flatMap(([key, fields]) =>
        entriesOf(block[key]).flatMap((entry) => fields.map((field) => entry[field])),
    );

    return [block.name, ...fieldValues].filter((value): value is string => typeof value === "string" && value !== "");
};

/** Every resource identity and Worker name production's config (top level and every environment) points at. */
const productionIdentities = (config: PreviewConfig): Set<string> =>
    new Set(
        [config, ...Object.entries(config.env ?? {}).flatMap(([key, block]) => (isPreviewBlock(config, key, block) ? [] : [block]))].flatMap((block) =>
            identitiesOf(block as Record<string, unknown>),
        ),
    );

/** The production identities a preview name or id collides with; a preview may touch none of them. */
const productionCollisions = (config: PreviewConfig, candidates: ReadonlyArray<string>): string[] => {
    const identities = productionIdentities(config);

    return candidates.filter((candidate) => identities.has(candidate));
};

export type { PreviewConfig, PreviewPlan, PreviewResourceKind, ResourceIds };
export { planPreview, PREVIEW_MARKER_VAR, previewEnvironmentBlock, previewMarker, previewNames, previewResourceName, productionCollisions, resourceKey };
