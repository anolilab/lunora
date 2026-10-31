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
import { createHash } from "node:crypto";

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
    /** The Wrangler environment the preview is planned from (`--env`); absent when it is planned from the top level. */
    sourceEnv?: string;
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
const COPIED_KEYS = ["ai", "browser", "define", "images", "media", "secrets", "vars", "version_metadata", "worker_loaders"] as const;

/** Settings the preview block sets for itself, so a source environment's values for them are not copied. */
const SETTINGS_KEPT_BY_BLOCK = new Set(["env", "name", "routes", "triggers", "workers_dev"]);

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

/** The var the scheduler dispatches its jobs to: the Worker's own public URL. */
const ORIGIN_VAR = "LUNORA_ORIGIN_URL";

/** The plain-text var every preview Worker carries: `<production>/<slug>`. */
const PREVIEW_MARKER_VAR = "LUNORA_PREVIEW";

const previewMarker = (names: Pick<PreviewPlan, "production" | "slug">): string => `${names.production}/${names.slug}`;

const NON_SLUG_CHARACTERS = /[^a-z0-9]+/u;

/**
 * The preview's name in Cloudflare's alphabet: lowercase letters, digits and single dashes. `foo_bar`, `Foo-Bar` and
 * `foo-bar` would all clean to `foo-bar` and so address one preview's Worker, record and resources; a name that
 * needed cleaning is closed with a short hash of the original, so each distinct name keeps a preview of its own.
 */
const previewSlug = (name: string): string => {
    const clean = name
        .toLowerCase()
        .split(NON_SLUG_CHARACTERS)
        .filter((part) => part !== "")
        .join("-");

    return clean === "" || clean === name ? clean : `${clean}-${createHash("sha256").update(name).digest("hex").slice(0, 6)}`;
};

/** The preview Worker's name: its own Durable Object namespace, derived from the production Worker's name at the time. */
const previewWorkerName = (production: string, slug: string): string => boundedName(`${production}-preview-${slug}`, NAME_LIMIT);

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
        names: { environment: boundedName(`preview-${slug}`, NAME_LIMIT), production, slug, worker: previewWorkerName(production, slug) },
    };
};

/**
 * Whether `env.<key>` is the block a preview run wrote: its key, Worker name and marker are all the ones the slug
 * and production name in its marker derive. Any other block, marked or not, is one of the user's environments.
 */
const isPreviewBlock = (_config: PreviewConfig, key: string, block: PreviewConfig | undefined): boolean => {
    const marker = block?.vars?.[PREVIEW_MARKER_VAR];
    const split = typeof marker === "string" ? marker.lastIndexOf("/") : -1;

    if (typeof marker !== "string" || split <= 0) {
        return false;
    }

    const production = marker.slice(0, split);
    const slug = marker.slice(split + 1);

    return (
        previewSlug(slug) === slug &&
        previewMarker({ production, slug }) === marker &&
        key === boundedName(`preview-${slug}`, NAME_LIMIT) &&
        block?.name === previewWorkerName(production, slug)
    );
};

/**
 * The config a preview of Wrangler environment `envName` is planned from: the top level's settings with `env.<envName>`
 * laid over them, as the app is deployed with `--env <envName>` (bindings and vars are not inherited by an environment). The Worker is named as Wrangler names it: the environment's own
 * `name`, else `<name>-<envName>`. An unknown environment is an error that lists the valid ones.
 */
const environmentConfig = (config: PreviewConfig, envName: string): { config: PreviewConfig; error?: never } | { config?: never; error: string } => {
    const blocks = Object.entries(config.env ?? {}).filter(([key, block]) => !isPreviewBlock(config, key, block));
    const found = blocks.find(([key]) => key === envName)?.[1];

    if (found === undefined) {
        return {
            error: `wrangler.jsonc declares no environment "${envName}"${blocks.length === 0 ? ", and no environments at all" : `; the environments are: ${blocks.map(([key]) => key).join(", ")}`}`,
        };
    }

    const top = typeof config.name === "string" ? config.name : "";

    // Wrangler inherits only the settings into an environment; vars and bindings are the environment's own, so the top
    // level's are not carried over (a preview must not receive a production var the environment never had). `exports` is
    // inherited too, and is where a workflow is declared: dropping it here would hide an inherited workflow from the refusal.
    const inherited = Object.fromEntries(Object.entries(config).filter(([key]) => SETTINGS_KEYS.has(key) || key === "exports"));

    return { config: { ...inherited, ...found, env: config.env, name: typeof found.name === "string" ? found.name : `${top}-${envName}` } };
};

/** The user's environments that name an `account_id` other than the top level's: previews made with `--env` there live in another account. */
const accountsOfEnvironments = (config: PreviewConfig): string[] =>
    Object.entries(config.env ?? {})
        .filter(([key, block]) => !isPreviewBlock(config, key, block))
        .filter(([, block]) => typeof block.account_id === "string" && block.account_id !== "" && block.account_id !== config.account_id)
        .map(([key]) => key);

/** The name of the resource a preview Worker owns for `binding`. */
const previewResourceName = (worker: string, binding: string): string => boundedName(`${worker}-${binding}`, NAME_LIMIT);

/**
 * A preview is planned from the top-level config unless `--env` says otherwise. Bindings declared only inside an
 * `env.<name>` (an app that deploys with `--env production`) would be missing from it, leaving a working-looking
 * preview with no database or storage.
 */
const declaredNames = (key: string, value: unknown): Set<string> => {
    const entries = key === "durable_objects" ? entriesOf((value as { bindings?: unknown } | undefined)?.bindings) : entriesOf(value);

    return new Set(entries.map((entry) => String(key === "durable_objects" ? entry.name : entry.binding)));
};

const envOnlyRefusals = (config: PreviewConfig): string[] =>
    Object.entries(config.env ?? {}).flatMap(([envName, block]) =>
        isPreviewBlock(config, envName, block)
            ? []
            : Object.entries(block as Record<string, unknown>).flatMap(([key, value]) => {
                  const top = (config as Record<string, unknown>)[key];

                  if (key in ISOLATED_KEYS || key === "durable_objects") {
                      const known = declaredNames(key, top);
                      const added = [...declaredNames(key, value)].filter((binding) => !known.has(binding));

                      return added.length === 0
                          ? []
                          : [
                                `"env.${envName}.${key}": binding ${added.map((binding) => `"${binding}"`).join(", ")} is declared only in this environment, and a preview is planned from the top-level config, which lacks it; pass --env ${envName} to preview that environment`,
                            ];
                  }

                  return refusalFor(key, value) !== undefined && isPresent(value) && !isPresent(top)
                      ? [
                            `"env.${envName}.${key}": declared only in this environment, and a preview is planned from the top-level config, which has none; pass --env ${envName} to preview that environment`,
                        ]
                      : [];
              }),
    );

/** The resources `config` declares, under the names a preview Worker `worker` gives them. Needs no valid plan: a refused config still declares them. */
const previewResources = (config: PreviewConfig, worker: string): PlannedResource[] =>
    Object.entries(ISOLATED_KEYS).flatMap(([key, kind]) =>
        entriesOf((config as Record<string, unknown>)[key]).map((entry) => {
            const binding = String(entry.binding);

            return { binding, kind, name: previewResourceName(worker, binding) };
        }),
    );

/** The plan for previewing `config` as `name`, or why it cannot be made. Pure: reads nothing, writes nothing. */
const planPreview = (config: PreviewConfig, name: string, fromEnv?: string): { error: string; plan?: never } | { error?: never; plan: PreviewPlan } => {
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
    refusals.push(...(fromEnv === undefined ? envOnlyRefusals(config) : []));

    const jurisdictional = entriesOf(config.r2_buckets).find((entry) => entry.jurisdiction !== undefined);

    if (jurisdictional !== undefined) {
        refusals.push(`"r2_buckets": the "${String(jurisdictional.binding)}" bucket has a jurisdiction, which a preview bucket is not created in yet`);
    }

    if (refusals.length > 0) {
        return { error: `this app cannot be previewed in isolation yet:\n  - ${refusals.join("\n  - ")}` };
    }

    const resources = previewResources(config, worker);

    // Binding names are case-sensitive but resource names are lowercase, so `DB` and `db` would share one.
    const shared = resources.find((resource, index) => resources.findIndex((other) => other.name === resource.name) !== index);

    if (shared !== undefined) {
        return {
            error: `two bindings would share the preview resource name "${shared.name}"; rename one of them (binding names differ only by case or punctuation)`,
        };
    }

    return { plan: { ...named.names, ...(fromEnv === undefined ? {} : { sourceEnv: fromEnv }), resources } };
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
 * A new environment inherits the top level's settings. Planned from another environment, the settings that environment
 * resolved (entry point, compatibility date and flags, assets, migrations, ...) are the ones the preview must run with.
 */
const copySourceSettings = (source: Record<string, unknown>, block: Entry, plan: PreviewPlan): void => {
    if (plan.sourceEnv === undefined) {
        return;
    }

    for (const [key, value] of Object.entries(source)) {
        if (SETTINGS_KEYS.has(key) && !(key in block) && !SETTINGS_KEPT_BY_BLOCK.has(key) && isPresent(value)) {
            // eslint-disable-next-line no-param-reassign -- the block is being built by the caller
            block[key] = value;
        }
    }
};

/**
 * The `env.<preview>` block. `routes: []` overrides production's inheritable routes and custom domains, empty
 * `triggers` keep production's crons from firing once per open preview, and `workers_dev` gives the preview its URL; `name` is set so wrangler's `<name>-<env>` default never applies.
 */
const previewEnvironmentBlock = (
    config: PreviewConfig,
    plan: PreviewPlan,
    ids: ResourceIds,
    overrides: Readonly<Record<string, string>> = {},
    origin?: string,
): Entry => {
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
    const inherited: Record<string, unknown> = isPresent(config.vars) ? { ...config.vars } : {};

    // The scheduler dispatches to this var: production's value would make the preview's jobs call production's Worker.
    if (ORIGIN_VAR in inherited) {
        inherited[ORIGIN_VAR] = origin ?? plan.worker;
    }

    block.vars = { ...inherited, ...overrides, ...marker };

    copySourceSettings(source, block, plan);

    if (isPresent(config.durable_objects)) {
        block.durable_objects = config.durable_objects;
    }

    // Written even when it equals the top level's: an environment that omits `exports` inherits production's, so the
    // block states the resolved map (the plan has already refused a workflow in it).
    if (isPresent(source.exports)) {
        block.exports = source.exports;
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

export type { PlannedResource, PreviewConfig, PreviewNames, PreviewPlan, PreviewResourceKind, ResourceIds };
export {
    accountsOfEnvironments,
    environmentConfig,
    planPreview,
    PREVIEW_MARKER_VAR,
    previewEnvironmentBlock,
    previewMarker,
    previewNames,
    previewResourceName,
    previewResources,
    previewWorkerName,
    productionCollisions,
    resourceKey,
};
