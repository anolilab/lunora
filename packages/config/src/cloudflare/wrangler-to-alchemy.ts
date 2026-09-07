/**
 * Translate a `wrangler.jsonc` into an [Alchemy](https://alchemy.run) program.
 *
 * # Why translate rather than ask for a second config
 *
 * `wrangler.jsonc` is already the source of truth for what an app needs, and
 * Lunora already infers and reconciles it — `inferLunoraBindings` decides that
 * a project needs a shard namespace and a bucket, `reconcileWranglerBindings`
 * writes them. Asking a developer to restate all of that in an
 * `alchemy.run.ts` would give the project two sources of truth that drift, and
 * the drift would surface as a deploy that provisions something the app does
 * not bind.
 *
 * So Alchemy is an implementation detail of `deploy`, not a thing to configure:
 * read the config, emit the program, run it.
 *
 * # Why this emits source rather than calling Alchemy
 *
 * `alchemy@0.93` has thirty dependencies, nine of them Node-shaped —
 * `wrangler`, `miniflare`, `esbuild`, `execa`, `find-process`, `glob`, `open`,
 * `proper-lockfile`, `signal-exit`. `@lunora/config` is imported by
 * `@lunora/vite`, so importing Alchemy here would push that tree into every
 * project that merely wanted to read `lunora.json`, and into any bundle
 * targeting workerd — where none of it survives.
 *
 * Emitting text keeps this module pure and dependency-free. Alchemy is invoked
 * as a CLI against the generated file, so it only has to exist on the machine
 * that deploys.
 *
 * # Adoption, not re-creation
 *
 * Every resource is emitted with `adopt: true`. A project translated from an
 * existing `wrangler.jsonc` already *has* its D1 database and its bucket, with
 * data in them. Without adoption Alchemy would treat them as new and try to
 * create alongside — the one outcome a deploy must never have.
 */

/** A Durable Object binding as `wrangler.jsonc` spells it. */
interface WranglerDurableObjectBinding {
    class_name?: string;
    name?: string;
    script_name?: string;
}

/** The slice of `wrangler.jsonc` that translates into Alchemy resources. */
interface WranglerConfigShape {
    compatibility_date?: string;
    compatibility_flags?: ReadonlyArray<string>;
    d1_databases?: ReadonlyArray<{ binding?: string; database_id?: string; database_name?: string }>;
    durable_objects?: { bindings?: ReadonlyArray<WranglerDurableObjectBinding> };
    kv_namespaces?: ReadonlyArray<{ binding?: string; id?: string }>;
    main?: string;
    /** `new_sqlite_classes` marks which DO classes get SQLite storage — Alchemy needs that per namespace. */
    migrations?: ReadonlyArray<{ new_classes?: ReadonlyArray<string>; new_sqlite_classes?: ReadonlyArray<string> }>;
    name?: string;
    /** Only `producers` translate; a `consumers` entry is dropped and reported as `queues.consumers`. */
    queues?: { consumers?: ReadonlyArray<{ queue?: string }>; producers?: ReadonlyArray<{ binding?: string; queue?: string }> };
    r2_buckets?: ReadonlyArray<{ binding?: string; bucket_name?: string }>;
    triggers?: { crons?: ReadonlyArray<string> };
    vars?: Readonly<Record<string, unknown>>;
}

/** What the translation could not carry over, so the caller can say so out loud. */
interface AlchemyTranslation {
    /** The emitted program source. */
    source: string;

    /**
     * Bindings present in `wrangler.jsonc` that this translation drops.
     *
     * Reported rather than silently omitted: a deploy that quietly loses a
     * Vectorize index produces a worker whose `env.POSTS_SEARCH` is undefined
     * at runtime, and nothing in the build says why.
     */
    unsupported: ReadonlyArray<string>;
}

/** JSON-encode for embedding in emitted source. Also the identifier-safety check's escape hatch. */
const literal = (value: unknown): string => JSON.stringify(value);

/**
 * Whether a binding name can be emitted as a bare object key / identifier.
 *
 * A binding is an env var name, so in practice it is `SCREAMING_SNAKE` — but
 * nothing enforces that, and a name with a hyphen would emit a program that
 * does not parse. Quoting the odd ones keeps the emitter total.
 */
const SAFE_IDENTIFIER = /^[A-Z_a-z][\w$]*$/u;

const isSafeIdentifier = (name: string): boolean => SAFE_IDENTIFIER.test(name);

/** The local const an emitted resource binds to, unique per binding name. */
const localName = (binding: string): string => (isSafeIdentifier(binding) ? binding : `binding_${binding.replaceAll(/\W/gu, "_")}`);

/**
 * One entry of the worker's `bindings` object.
 *
 * Emits shorthand (`DB,`) when the binding name is already the local const —
 * the generated file is committed-adjacent and gets read by humans debugging a
 * deploy, and `DB: DB` is noise.
 */
const bindingEntry = (binding: string, value: string = localName(binding)): string => {
    const safe = isSafeIdentifier(binding);

    if (safe && value === binding) {
        return `${binding},`;
    }

    return `${safe ? binding : literal(binding)}: ${value},`;
};

/**
 * The set of Durable Object classes that use SQLite storage.
 *
 * Alchemy needs this per namespace; wrangler records it once per migration
 * entry, so it is accumulated across all of them rather than read off the
 * newest — a class introduced in `v1` is still SQLite-backed at `v3`.
 */
const sqliteClasses = (config: WranglerConfigShape): ReadonlySet<string> => {
    const classes = new Set<string>();

    for (const migration of config.migrations ?? []) {
        for (const className of migration.new_sqlite_classes ?? []) {
            classes.add(className);
        }
    }

    return classes;
};

/** Durable Object bindings. Not provisioned resources — the namespace is created with the worker. */
const collectDurableObjects = (
    config: WranglerConfigShape,
    sqlite: ReadonlySet<string>,
    imports: Set<string>,
    bindings: string[],
    unsupported: string[],
): void => {
    for (const durableObject of config.durable_objects?.bindings ?? []) {
        if (durableObject.name === undefined || durableObject.class_name === undefined) {
            continue;
        }

        if (durableObject.script_name !== undefined) {
            // A namespace implemented by *another* worker. Alchemy models this,
            // but the other worker is outside this program's scope, so carrying
            // it over would bind to something the program never creates.
            unsupported.push(`durable_objects.${durableObject.name} (external script_name "${durableObject.script_name}")`);

            continue;
        }

        imports.add("DurableObjectNamespace");
        // Not awaited: `DurableObjectNamespace` is a binding descriptor, not a
        // provisioned resource — the namespace is created with the worker.
        bindings.push(
            bindingEntry(
                durableObject.name,
                `DurableObjectNamespace(${literal(durableObject.name)}, { className: ${literal(durableObject.class_name)}, sqlite: ${String(sqlite.has(durableObject.class_name))} })`,
            ),
        );
    }
};

/**
 * Plain `vars` ride onto the worker as literal bindings.
 *
 * `literal(value)`, not `literal(String(value))`: wrangler `vars` are JSON, so a
 * numeric `"MAX": 5` is a number and stringifying it first shipped the worker a
 * `"5"` it then compared against a number — a silent type change under a
 * translation whose whole promise is fidelity.
 */
const collectVariables = (config: WranglerConfigShape, bindings: string[]): void => {
    for (const [key, value] of Object.entries(config.vars ?? {})) {
        bindings.push(bindingEntry(key, literal(value)));
    }
};

/**
 * Every wrangler field this translation drops, named individually so the message
 * is actionable.
 *
 * The list is the set Lunora itself can write into `wrangler.jsonc` minus the
 * kinds emitted above — because a field that is dropped AND unreported is the
 * exact failure `unsupported` exists to prevent, and this list once held only
 * the fields with a top-level array. `queues` is the awkward one: the producers
 * ARE emitted, so only a `consumers` entry is dropped, and it is reported under
 * its own path.
 */
const UNSUPPORTED_FIELDS = [
    "ai",
    "analytics_engine_datasets",
    "assets",
    "browser",
    "containers",
    "flagship",
    "hyperdrive",
    "images",
    "pipelines",
    "secrets_store_secrets",
    "send_email",
    "services",
    "tail_consumers",
    "vectorize",
    "workflows",
] as const;

const collectUnsupported = (config: WranglerConfigShape, unsupported: string[]): void => {
    for (const field of UNSUPPORTED_FIELDS) {
        const present = (config as Record<string, unknown>)[field];

        if (present !== undefined && (!Array.isArray(present) || present.length > 0)) {
            unsupported.push(field);
        }
    }

    if ((config.queues?.consumers?.length ?? 0) > 0) {
        unsupported.push("queues.consumers");
    }
};

/**
 * Translate a parsed `wrangler.jsonc` into an Alchemy program.
 *
 * Pure: it reads nothing and writes nothing, so the caller decides where the
 * source lands and the whole thing stays testable as a string comparison.
 * @param config The parsed `wrangler.jsonc`.
 * @returns the program source, plus whatever could not be carried over.
 */
const wranglerToAlchemy = (config: WranglerConfigShape): AlchemyTranslation => {
    const workerName = config.name ?? "worker";
    const unsupported: string[] = [];
    const imports = new Set<string>(["Worker"]);
    const resources: string[] = [];
    const bindings: string[] = [];
    const sqlite = sqliteClasses(config);

    // The four provisioned kinds differ only in constructor and name field, so
    // they run through one pass — a loop each was four chances to forget
    // `adopt`.
    const provisioned: ReadonlyArray<{ construct: string; entries: ReadonlyArray<{ binding?: string; name?: string }>; nameKey: string }> = [
        {
            construct: "D1Database",
            entries: (config.d1_databases ?? []).map((d) => {
                return { binding: d.binding, name: d.database_name };
            }),
            nameKey: "name",
        },
        {
            construct: "R2Bucket",
            entries: (config.r2_buckets ?? []).map((b) => {
                return { binding: b.binding, name: b.bucket_name };
            }),
            nameKey: "name",
        },
        {
            construct: "KVNamespace",
            entries: (config.kv_namespaces ?? []).map((k) => {
                return { binding: k.binding, name: k.binding };
            }),
            nameKey: "title",
        },
        {
            construct: "Queue",
            entries: (config.queues?.producers ?? []).map((q) => {
                return { binding: q.binding, name: q.queue };
            }),
            nameKey: "name",
        },
    ];

    for (const { construct, entries, nameKey } of provisioned) {
        for (const entry of entries) {
            if (entry.binding === undefined) {
                continue;
            }

            imports.add(construct);
            // `adopt` on every one: the project already has these, with data in
            // them. The declared name is what Alchemy matches on when adopting.
            resources.push(
                `const ${localName(entry.binding)} = await ${construct}(${literal(entry.binding)}, { adopt: true, ${nameKey}: ${literal(entry.name ?? entry.binding)} });`,
            );
            bindings.push(bindingEntry(entry.binding));
        }
    }

    collectDurableObjects(config, sqlite, imports, bindings, unsupported);
    collectVariables(config, bindings);
    collectUnsupported(config, unsupported);

    const workerProps = [
        "adopt: true,",
        bindings.length === 0 ? undefined : `bindings: {\n        ${bindings.join("\n        ")}\n    },`,
        config.compatibility_date === undefined ? undefined : `compatibilityDate: ${literal(config.compatibility_date)},`,
        config.compatibility_flags === undefined || config.compatibility_flags.length === 0
            ? undefined
            : `compatibilityFlags: ${literal([...config.compatibility_flags])},`,
        config.triggers?.crons === undefined || config.triggers.crons.length === 0 ? undefined : `crons: ${literal([...config.triggers.crons])},`,
        config.main === undefined ? undefined : `entrypoint: ${literal(config.main)},`,
        `name: ${literal(workerName)},`,
    ].filter((line): line is string => line !== undefined);

    const source = [
        "// GENERATED by @lunora/config from wrangler.jsonc — do not edit.",
        "// Re-generated on every `lunora deploy`; edit wrangler.jsonc instead.",
        "",
        `import alchemy from "alchemy";`,
        `import { ${[...imports].toSorted((a, b) => a.localeCompare(b)).join(", ")} } from "alchemy/cloudflare";`,
        "",
        `const app = await alchemy(${literal(workerName)});`,
        "",
        ...(resources.length === 0 ? [] : [...resources, ""]),
        `export const worker = await Worker(${literal(workerName)}, {`,
        `    ${workerProps.join("\n    ")}`,
        "});",
        "",
        "await app.finalize();",
        "",
    ].join("\n");

    return { source, unsupported };
};

export type { AlchemyTranslation, WranglerConfigShape };
export { sqliteClasses, wranglerToAlchemy };
