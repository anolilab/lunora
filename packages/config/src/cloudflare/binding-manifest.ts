/**
 * Describe, as portable data, everything a built Worker needs provisioned.
 *
 * # Why this exists
 *
 * `lunora deploy` is the batteries-included path: it infers what the app needs,
 * reconciles `wrangler.jsonc`, provisions, and publishes. A project that already
 * runs its own infrastructure-as-code does not want that half — it wants the
 * bundle, plus a statement of the resources the bundle expects to be bound to,
 * so its own program can create them.
 *
 * Without such a statement the requirements get restated by hand in the IaC
 * program, and the two drift silently: a binding added on one side is simply
 * missing on the other, and the failure lands at runtime as an undefined `env.X`.
 *
 * `wranglerToAlchemy` solves the adjacent problem (translate the config into a
 * program to run). This solves the complementary one: hand back the
 * requirements so an existing program can consume them, in whatever tool.
 *
 * # Why it reads `wrangler.jsonc` rather than re-inferring
 *
 * By the time `lunora build` has produced a bundle, the pre-deploy pipeline has
 * already run `inferLunoraBindings` and `reconcileWranglerBindings`, so the
 * config on disk IS the resolved answer. Deriving the manifest from anything
 * else would create a third source of truth to keep in step.
 *
 * # Why every binding is listed, including the ones Lunora cannot provision
 *
 * A KV namespace id, a Hyperdrive id, a Vectorize index — Lunora warns about
 * these and never writes them, because it cannot mint them. Those are precisely
 * the ones an external deployer CAN create, so omitting them would leave out the
 * half the consumer most needs. Anything unrecognised is reported in
 * {@link BindingManifest.unknown} rather than dropped, so a binding type added to
 * wrangler before it is added here degrades to a name instead of vanishing.
 */
import type { WranglerConfigShape } from "./wrangler-to-alchemy";

/** Schema version of the emitted document, so a consumer can gate on shape changes. */
const BINDING_MANIFEST_VERSION = 1;

/**
 * One resource the built Worker expects to be bound to. `binding` is the name the
 * Worker reads off `env`; the remaining fields are whatever identifies the
 * resource for that type, omitted when the config does not carry them (an id
 * Lunora could not mint is absent here exactly as it is absent from the config).
 */
interface BindingRequirement {
    /** The `env` property name the Worker reads. */
    binding: string;

    /**
     * Durable Object / Workflow / Container class the Worker must export. Present
     * for the class-backed binding types, so a deployer can assert the bundle
     * exports it before publishing.
     */
    className?: string;
    /** Bucket name (`r2`), database name (`d1`), dataset (`analytics_engine`), queue name (`queue`), index (`vectorize`), pipeline (`pipelines`). */
    resource?: string;
    /** Remote resource id, when the config declares one (`d1`, `kv`, `hyperdrive`). */
    resourceId?: string;
    /** For `durable_object`: whether the class uses SQLite storage (`new_sqlite_classes`). */
    sqlite?: boolean;
    /** The kind of resource, keyed to the wrangler section it came from. */
    type:
        | "ai"
        | "analytics_engine"
        | "assets"
        | "browser"
        | "container"
        | "d1"
        | "durable_object"
        | "hyperdrive"
        | "images"
        | "kv"
        | "pipeline"
        | "queue_consumer"
        | "queue_producer"
        | "r2"
        | "vectorize"
        | "workflow";
}

/** The document the `lunora build --emit-bindings` flag writes. */
interface BindingManifest {
    /** Every resource the Worker expects, sorted by `type` then `binding` so the file is diff-stable. */
    bindings: ReadonlyArray<BindingRequirement>;
    /** `compatibility_date`, when declared. */
    compatibilityDate?: string;
    /** `compatibility_flags`, when declared. */
    compatibilityFlags?: ReadonlyArray<string>;
    /** Cron expressions the Worker must be triggered on (`triggers.crons`). */
    crons: ReadonlyArray<string>;
    /** Worker name from `wrangler.jsonc`. */
    name?: string;

    /**
     * Wrangler sections present in the config that this version does not model,
     * by field name. Empty for a fully-understood config; non-empty is a prompt to
     * extend the collector, and is surfaced to the user rather than silently
     * dropped.
     */
    unknown: ReadonlyArray<string>;
    /** Names of `vars` entries. Values are deliberately excluded — a manifest is committed and read by CI, and a `vars` entry can hold a value a project would rather not publish. */
    vars: ReadonlyArray<string>;
    /** Schema version — {@link BINDING_MANIFEST_VERSION}. */
    version: number;
}

/**
 * Wrangler sections carried into the manifest, beyond the ones read explicitly
 * below. Used to decide what lands in {@link BindingManifest.unknown}: a
 * top-level key that is neither a known binding section nor a known non-binding
 * setting is something this translation has not caught up with.
 */
const NON_BINDING_FIELDS = new Set([
    "$schema",
    "account_id",
    "compatibility_date",
    "compatibility_flags",
    "keep_vars",
    "main",
    "migrations",
    "minify",
    "name",
    "observability",
    "placement",
    "routes",
    "rules",
    "triggers",
    "upload_source_maps",
    "vars",
    "workers_dev",
]);

/**
 * The wider config this reads. {@link WranglerConfigShape} covers what the
 * Alchemy translation models; a manifest additionally reports the sections that
 * translation lists as unsupported, so those are declared here.
 */
interface ManifestConfigShape extends WranglerConfigShape {
    ai?: { binding?: string };
    analytics_engine_datasets?: ReadonlyArray<{ binding?: string; dataset?: string }>;
    /** Static assets carry a real `binding` the Worker reads (`env.ASSETS`). */
    assets?: { binding?: string; directory?: string };
    browser?: { binding?: string };
    containers?: ReadonlyArray<{ class_name?: string; image?: string; max_instances?: number }>;
    hyperdrive?: ReadonlyArray<{ binding?: string; id?: string }>;
    images?: { binding?: string };
    pipelines?: ReadonlyArray<{ binding?: string; pipeline?: string }>;
    /** Adds `consumers` — the Alchemy translation models producers only. */
    queues?: { consumers?: ReadonlyArray<{ queue?: string }>; producers?: ReadonlyArray<{ binding?: string; queue?: string }> };
    vectorize?: ReadonlyArray<{ binding?: string; index_name?: string }>;
    workflows?: ReadonlyArray<{ binding?: string; class_name?: string; name?: string }>;
}

/** Every DO class declared with SQLite storage, across all migration entries. */
const sqliteClassNames = (config: ManifestConfigShape): ReadonlySet<string> => {
    const names = new Set<string>();

    for (const migration of config.migrations ?? []) {
        for (const className of migration.new_sqlite_classes ?? []) {
            names.add(className);
        }
    }

    return names;
};

/** Drop keys whose value is `undefined` so the emitted JSON carries no empty fields. */
const compact = (requirement: BindingRequirement): BindingRequirement =>
    Object.fromEntries(Object.entries(requirement).filter(([, value]) => value !== undefined)) as unknown as BindingRequirement;

/**
 * Every array-shaped wrangler section that maps to one binding per entry, as a
 * table rather than a loop apiece.
 *
 * `binding`/`resource`/`resourceId` name the entry fields each section uses for
 * the three manifest columns. Keeping it declarative means adding a section is
 * one row — and lets {@link KNOWN_BINDING_FIELDS} be derived from it, instead of
 * a third hand-maintained list that can silently fall out of step.
 */
const ARRAY_SECTIONS: ReadonlyArray<{
    bindingKey: string;
    field: keyof ManifestConfigShape;
    resourceIdKey?: string;
    resourceKey?: string;
    type: BindingRequirement["type"];
}> = [
    { bindingKey: "binding", field: "analytics_engine_datasets", resourceKey: "dataset", type: "analytics_engine" },
    // Keyed by `class_name`, not `name`: a wrangler `containers[]` entry has no
    // `name` field at all (see `@lunora/config`'s own `ContainerEntry`). Keying on
    // the absent field pushed every real container into `unnamed` — the manifest
    // reporting a problem it had invented. The identity IS the class, which is
    // also how the paired `durable_objects.bindings` entry finds it; `image` is
    // the thing an external deployer has to build or pull.
    { bindingKey: "class_name", field: "containers", resourceKey: "image", type: "container" },
    { bindingKey: "binding", field: "d1_databases", resourceIdKey: "database_id", resourceKey: "database_name", type: "d1" },
    { bindingKey: "binding", field: "hyperdrive", resourceIdKey: "id", type: "hyperdrive" },
    { bindingKey: "binding", field: "kv_namespaces", resourceIdKey: "id", type: "kv" },
    { bindingKey: "binding", field: "pipelines", resourceKey: "pipeline", type: "pipeline" },
    { bindingKey: "binding", field: "r2_buckets", resourceKey: "bucket_name", type: "r2" },
    { bindingKey: "binding", field: "vectorize", resourceKey: "index_name", type: "vectorize" },
    { bindingKey: "binding", field: "workflows", resourceKey: "name", type: "workflow" },
];

/** Parameterless `{ binding }` sections — the platform capabilities with nothing to provision. */
const SINGLETON_SECTIONS: ReadonlyArray<{ field: "ai" | "assets" | "browser" | "images"; type: BindingRequirement["type"] }> = [
    { field: "ai", type: "ai" },
    { field: "assets", type: "assets" },
    { field: "browser", type: "browser" },
    { field: "images", type: "images" },
];

/** The binding sections this module understands, derived from the tables above so the three can never disagree. */
const KNOWN_BINDING_FIELDS = new Set<string>([
    ...ARRAY_SECTIONS.map((section) => section.field as string),
    ...SINGLETON_SECTIONS.map((section) => section.field),
    "durable_objects",
    "queues",
]);

const readString = (entry: Record<string, unknown>, key: string | undefined): string | undefined => {
    const value = key === undefined ? undefined : entry[key];

    return typeof value === "string" && value !== "" ? value : undefined;
};

/** The table-driven sections: one binding per array entry. */
const collectArrayBindings = (config: ManifestConfigShape, unnamed: string[]): BindingRequirement[] => {
    const out: BindingRequirement[] = [];

    for (const section of ARRAY_SECTIONS) {
        for (const raw of (config[section.field] as ReadonlyArray<Record<string, unknown>> | undefined) ?? []) {
            const binding = readString(raw, section.bindingKey);

            // A section entry with no binding name has nothing a Worker can read
            // off `env`. Emitting `{"binding": ""}` would hand an IaC program a
            // resource it cannot wire, so it is reported instead — the same
            // "surface it, never invent it" rule the `unknown` list follows.
            if (binding === undefined) {
                unnamed.push(section.field);
                continue;
            }

            out.push({
                binding,
                className: readString(raw, "class_name"),
                resource: readString(raw, section.resourceKey),
                resourceId: readString(raw, section.resourceIdKey),
                type: section.type,
            });
        }
    }

    return out;
};

/** Durable Objects — the only section whose storage mode is declared elsewhere (`migrations`). */
const collectDurableObjectBindings = (config: ManifestConfigShape, unnamed: string[]): BindingRequirement[] => {
    const sqlite = sqliteClassNames(config);
    const out: BindingRequirement[] = [];

    for (const entry of config.durable_objects?.bindings ?? []) {
        if (entry.name === undefined || entry.name === "") {
            unnamed.push("durable_objects");
            continue;
        }

        out.push({
            binding: entry.name,
            className: entry.class_name,
            // Only meaningful for a class this Worker defines; a `script_name`
            // binding points at another Worker's class, whose storage mode is
            // that Worker's business.
            sqlite: entry.script_name === undefined && entry.class_name !== undefined ? sqlite.has(entry.class_name) : undefined,
            type: "durable_object",
        });
    }

    return out;
};

/** Queues — the one section producing two kinds, only one of which is an `env` binding. */
const collectQueueBindings = (config: ManifestConfigShape, unnamed: string[]): BindingRequirement[] => {
    const out: BindingRequirement[] = [];

    for (const entry of config.queues?.producers ?? []) {
        if (entry.binding === undefined || entry.binding === "") {
            unnamed.push("queues.producers");
            continue;
        }

        out.push({ binding: entry.binding, resource: entry.queue, type: "queue_producer" });
    }

    // A consumer has no `env` binding — it is a subscription. `binding` carries
    // the queue name so the entry still has a stable identity to sort and diff on.
    for (const entry of config.queues?.consumers ?? []) {
        if (entry.queue === undefined || entry.queue === "") {
            unnamed.push("queues.consumers");
            continue;
        }

        out.push({ binding: entry.queue, resource: entry.queue, type: "queue_consumer" });
    }

    return out;
};

const collectBindings = (config: ManifestConfigShape, unnamed: string[]): BindingRequirement[] => [
    ...collectArrayBindings(config, unnamed),
    ...collectDurableObjectBindings(config, unnamed),
    ...collectQueueBindings(config, unnamed),
    ...SINGLETON_SECTIONS.filter((section) => config[section.field]?.binding !== undefined).map((section) => {
        return { binding: config[section.field]?.binding as string, type: section.type };
    }),
];

/**
 * Build the manifest for a parsed `wrangler.jsonc`.
 *
 * Pure: reads nothing and writes nothing, so the caller decides where the
 * document lands and the mapping stays testable as a plain object comparison.
 * @param config The parsed, already-reconciled `wrangler.jsonc`.
 * @returns the requirements document.
 */
const buildBindingManifest = (config: ManifestConfigShape): BindingManifest => {
    // Entries this run could not name. Reported alongside the unmodelled
    // sections, for the same reason: an under-provisioned deploy must be visible
    // here rather than at runtime.
    const unnamed: string[] = [];
    const bindings = collectBindings(config, unnamed)
        .map((requirement) => compact(requirement))
        .toSorted((a, b) => a.type.localeCompare(b.type) || a.binding.localeCompare(b.binding));

    const unknown = [
        ...Object.keys(config).filter((field) => !NON_BINDING_FIELDS.has(field) && !KNOWN_BINDING_FIELDS.has(field)),
        ...unnamed.map((field) => `${field} (entry with no binding name)`),
    ].toSorted((a, b) => a.localeCompare(b));

    return {
        bindings,
        ...(config.compatibility_date === undefined ? {} : { compatibilityDate: config.compatibility_date }),
        ...(config.compatibility_flags === undefined ? {} : { compatibilityFlags: config.compatibility_flags }),
        crons: config.triggers?.crons ?? [],
        ...(config.name === undefined ? {} : { name: config.name }),
        unknown,
        vars: Object.keys(config.vars ?? {}).toSorted((a, b) => a.localeCompare(b)),
        version: BINDING_MANIFEST_VERSION,
    };
};

export { BINDING_MANIFEST_VERSION, buildBindingManifest };
export type { BindingManifest, BindingRequirement, ManifestConfigShape };
