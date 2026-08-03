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
    "account_id",
    "assets",
    "compatibility_date",
    "compatibility_flags",
    "env",
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

/** The binding sections {@link collectBindings} understands. */
const KNOWN_BINDING_FIELDS = new Set([
    "ai",
    "analytics_engine_datasets",
    "browser",
    "containers",
    "d1_databases",
    "durable_objects",
    "hyperdrive",
    "images",
    "kv_namespaces",
    "pipelines",
    "queues",
    "r2_buckets",
    "vectorize",
    "workflows",
]);

/**
 * The wider config this reads. {@link WranglerConfigShape} covers what the
 * Alchemy translation models; a manifest additionally reports the sections that
 * translation lists as unsupported, so those are declared here.
 */
interface ManifestConfigShape extends WranglerConfigShape {
    ai?: { binding?: string };
    analytics_engine_datasets?: ReadonlyArray<{ binding?: string; dataset?: string }>;
    browser?: { binding?: string };
    containers?: ReadonlyArray<{ class_name?: string; name?: string }>;
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

// eslint-disable-next-line sonarjs/cognitive-complexity -- one linear pass per wrangler section; splitting it would scatter the section↔type mapping this file exists to state
const collectBindings = (config: ManifestConfigShape): BindingRequirement[] => {
    const out: BindingRequirement[] = [];
    const sqlite = sqliteClassNames(config);

    for (const entry of config.d1_databases ?? []) {
        out.push({ binding: entry.binding ?? "", resource: entry.database_name, resourceId: entry.database_id, type: "d1" });
    }

    for (const entry of config.r2_buckets ?? []) {
        out.push({ binding: entry.binding ?? "", resource: entry.bucket_name, type: "r2" });
    }

    for (const entry of config.kv_namespaces ?? []) {
        out.push({ binding: entry.binding ?? "", resourceId: entry.id, type: "kv" });
    }

    for (const entry of config.durable_objects?.bindings ?? []) {
        const className = entry.class_name;

        out.push({
            binding: entry.name ?? "",
            className,
            // Only meaningful for a class this Worker defines; a `script_name`
            // binding points at another Worker's class, whose storage mode is
            // that Worker's business.
            sqlite: entry.script_name === undefined && className !== undefined ? sqlite.has(className) : undefined,
            type: "durable_object",
        });
    }

    for (const entry of config.vectorize ?? []) {
        out.push({ binding: entry.binding ?? "", resource: entry.index_name, type: "vectorize" });
    }

    for (const entry of config.hyperdrive ?? []) {
        out.push({ binding: entry.binding ?? "", resourceId: entry.id, type: "hyperdrive" });
    }

    for (const entry of config.queues?.producers ?? []) {
        out.push({ binding: entry.binding ?? "", resource: entry.queue, type: "queue_producer" });
    }

    // A consumer has no `env` binding — it is a subscription. `binding` carries
    // the queue name so the entry still has a stable identity to sort and diff on.
    for (const entry of config.queues?.consumers ?? []) {
        out.push({ binding: entry.queue ?? "", resource: entry.queue, type: "queue_consumer" });
    }

    for (const entry of config.workflows ?? []) {
        out.push({ binding: entry.binding ?? "", className: entry.class_name, resource: entry.name, type: "workflow" });
    }

    for (const entry of config.containers ?? []) {
        out.push({ binding: entry.name ?? "", className: entry.class_name, type: "container" });
    }

    for (const entry of config.analytics_engine_datasets ?? []) {
        out.push({ binding: entry.binding ?? "", resource: entry.dataset, type: "analytics_engine" });
    }

    for (const [section, type] of [
        [config.ai, "ai"],
        [config.browser, "browser"],
        [config.images, "images"],
    ] as const) {
        if (section?.binding !== undefined) {
            out.push({ binding: section.binding, type });
        }
    }

    for (const entry of config.pipelines ?? []) {
        out.push({ binding: entry.binding ?? "", resource: entry.pipeline, type: "pipeline" });
    }

    return out;
};

/**
 * Build the manifest for a parsed `wrangler.jsonc`.
 *
 * Pure: reads nothing and writes nothing, so the caller decides where the
 * document lands and the mapping stays testable as a plain object comparison.
 * @param config The parsed, already-reconciled `wrangler.jsonc`.
 * @returns the requirements document.
 */
const buildBindingManifest = (config: ManifestConfigShape): BindingManifest => {
    const unknown = Object.keys(config)
        .filter((field) => !NON_BINDING_FIELDS.has(field) && !KNOWN_BINDING_FIELDS.has(field))
        .toSorted((a, b) => a.localeCompare(b));

    const bindings = collectBindings(config)
        .map((requirement) => compact(requirement))
        .toSorted((a, b) => a.type.localeCompare(b.type) || a.binding.localeCompare(b.binding));

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
