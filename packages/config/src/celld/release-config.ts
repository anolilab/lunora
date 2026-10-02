/**
 * The wrangler config a celld fleet runs a STORED RELEASE with (plan 458 W3).
 *
 * `lunora-hostd` never sees a project checkout. A box downloads the release the
 * control plane stored for a deployment — the prebuilt Worker bundle, the
 * binding manifest `lunora build --emit-bindings` wrote, and the static assets —
 * and has to hand `celld deploy` a Wrangler config for it. This builds that
 * config from the manifest alone.
 *
 * The bundle is already built, so the config names it as `main` with
 * `no_bundle`, and celld needs no esbuild on the box. D1, KV, R2 and queues get
 * the same per-project names on every target, `{alias}--{binding}` — the rule
 * `apps/cloud`'s `tenantResourceName` applies on Workers for Platforms — so a
 * project moved between targets keeps its names. Durable Object classes must
 * be SQLite-backed: celld creates nothing else, so one cumulative
 * `new_sqlite_classes` migration lists them all. Binding types celld cannot run
 * are refused by name, all at once, before anything is written: the same set
 * the `celld-vps` row of the control plane's binding table refuses
 * (`apps/cloud/src/provision-contract.ts`, where a test pins the two together).
 *
 * The result goes through {@link projectCelldConfig}, the projection every celld
 * deploy uses, so it can only ever hold the top-level keys celld accepts.
 */
import type { BindingRequirement } from "../cloudflare/binding-manifest";
import { projectCelldConfig } from "./celld-config";

/** The binding manifest a stored release carries (`DeployManifest` in `apps/cloud`). */
interface CelldReleaseManifest {
    bindings: ReadonlyArray<BindingRequirement>;
    compatibilityDate?: string;
    compatibilityFlags?: ReadonlyArray<string>;
}

/** The serving options of a release's static assets: the subset of wrangler's `assets` the deploy request carries. */
interface CelldReleaseAssetsConfig {
    html_handling?: "auto-trailing-slash" | "drop-trailing-slash" | "force-trailing-slash" | "none";
    not_found_handling?: "404-page" | "none" | "single-page-application";
    run_worker_first?: boolean | ReadonlyArray<string>;
}

interface CelldReleaseOptions {
    /** The deployment alias: the fleet's Worker name and the prefix of every resource name. */
    alias: string;
    /** Serving options for the assets, when the release has any. */
    assetsConfig?: CelldReleaseAssetsConfig;
    /** The deploy job's compatibility date; wins over the manifest's. */
    compatibilityDate?: string;
    /** Wins over the manifest's flags. Without either, `["nodejs_compat"]`, the platform default. */
    compatibilityFlags?: ReadonlyArray<string>;
    /** Cron expressions celld fires natively (plan 458 D11). */
    crons: ReadonlyArray<string>;
    /** Whether the release carries static assets; they are written to {@link CELLD_RELEASE_ASSETS_DIRECTORY}. */
    hasAssets: boolean;
    /** Vars and secrets, merged (plan 458 D10). */
    vars: Readonly<Record<string, string>>;
}

/** One binding celld cannot run, and why. */
interface CelldReleaseRefusal {
    binding: string;
    reason: string;
    type: BindingRequirement["type"];
}

/** Thrown when a release cannot run on celld; {@link CelldReleaseConfigError.refused} lists every binding at fault. */
class CelldReleaseConfigError extends Error {
    public readonly refused: ReadonlyArray<CelldReleaseRefusal>;

    public constructor(message: string, refused: ReadonlyArray<CelldReleaseRefusal> = []) {
        super(message);
        this.name = "CelldReleaseConfigError";
        this.refused = refused;
    }
}

/** Where the bundle sits in the release directory, beside the config. */
const CELLD_RELEASE_MAIN = "worker.js";

/** Where the static assets sit in the release directory. */
const CELLD_RELEASE_ASSETS_DIRECTORY = "assets";

/** The tag of the one migration listing every Durable Object class. celld accepts a growing class list under the same tag. */
const MIGRATION_TAG = "lunora-v1";

const DEFAULT_COMPATIBILITY_FLAGS: ReadonlyArray<string> = ["nodejs_compat"];

/**
 * The binding types a celld fleet runs, and so a release may carry. Every other
 * type is refused. Kept equal to the types the `celld-vps` row of the control
 * plane's binding table does not mark `unsupported`.
 */
const CELLD_RELEASE_BINDING_TYPES: ReadonlySet<BindingRequirement["type"]> = new Set([
    "assets",
    "d1",
    "durable_object",
    "kv",
    "queue_consumer",
    "queue_producer",
    "r2",
    "workflow",
]);

/** One DNS label: dash-separated runs of `[a-z0-9]`, at most 63 characters — the alias rule of every target. */
const ALIAS_PATTERN = /^[a-z\d]+(?:-[a-z\d]+)*$/u;

const MAX_ALIAS_LENGTH = 63;

/** The tightest name limit across the named resource types (R2 buckets, queues). */
const MAX_RESOURCE_NAME = 63;

/**
 * The per-project name of a D1 database, KV namespace, R2 bucket or queue:
 * `{alias}--{binding}`, the binding lowercased with `_` → `-`. Injective, since an
 * alias never contains `--`; the same rule `apps/cloud` names Workers for
 * Platforms resources with.
 * @throws {CelldReleaseConfigError} when the alias is malformed or the name is over 63 characters.
 */
const releaseResourceName = (alias: string, binding: string): string => {
    if (alias.length > MAX_ALIAS_LENGTH || !ALIAS_PATTERN.test(alias)) {
        throw new CelldReleaseConfigError(`alias "${alias}" must be dash-separated runs of [a-z0-9], at most 63 characters`);
    }

    const name = `${alias}--${binding.toLowerCase().replaceAll("_", "-")}`;

    if (name.length > MAX_RESOURCE_NAME) {
        throw new CelldReleaseConfigError(
            `resource name "${name}" exceeds ${String(MAX_RESOURCE_NAME)} characters; shorten the project name or binding ${binding}`,
        );
    }

    return name;
};

/** Why celld cannot run `requirement`, or `undefined` when it can. */
const refusalOf = (requirement: BindingRequirement): string | undefined => {
    if (!CELLD_RELEASE_BINDING_TYPES.has(requirement.type)) {
        return `${requirement.type} bindings do not run on celld`;
    }

    if (requirement.type === "durable_object") {
        if (requirement.className === undefined) {
            return "a Durable Object binding must name its class";
        }

        // `undefined` is a binding to another Worker's class, which a single-app fleet cannot reach.
        if (requirement.sqlite !== true) {
            return requirement.sqlite === false
                ? `class ${requirement.className} is KV-backed, and celld creates only SQLite-backed classes`
                : `class ${requirement.className} belongs to another Worker; a celld fleet runs one`;
        }
    }

    if (requirement.type === "workflow" && requirement.className === undefined) {
        return "a workflow binding must name its class";
    }

    return undefined;
};

type Config = Record<string, unknown>;

const ofType = (manifest: CelldReleaseManifest, type: BindingRequirement["type"]): BindingRequirement[] =>
    manifest.bindings.filter((requirement) => requirement.type === type);

/** Queue producers and consumers. A consumer of a queue the Worker also produces to shares the producer's queue. */
const queueSection = (alias: string, manifest: CelldReleaseManifest): Config | undefined => {
    const producers = ofType(manifest, "queue_producer");
    const consumers = ofType(manifest, "queue_consumer");

    if (producers.length === 0 && consumers.length === 0) {
        return undefined;
    }

    const producerNames = new Map(producers.map((producer) => [producer.resource ?? producer.binding, releaseResourceName(alias, producer.binding)]));

    return {
        ...(producers.length === 0
            ? {}
            : {
                  producers: producers.map((producer) => {
                      return { binding: producer.binding, queue: releaseResourceName(alias, producer.binding) };
                  }),
              }),
        ...(consumers.length === 0
            ? {}
            : {
                  consumers: consumers.map((consumer) => {
                      return { queue: producerNames.get(consumer.resource ?? consumer.binding) ?? releaseResourceName(alias, consumer.binding) };
                  }),
              }),
    };
};

/** The sections every binding type maps to, keyed by their wrangler name; absent when the release has none of that type. */
const bindingSections = (alias: string, manifest: CelldReleaseManifest, options: CelldReleaseOptions): Config => {
    const durableObjects = ofType(manifest, "durable_object");
    const sqliteClasses = [...new Set(durableObjects.map((requirement) => requirement.className as string))].toSorted((a, b) => a.localeCompare(b));
    const assets = ofType(manifest, "assets")[0];
    const sections: Config = {
        assets: options.hasAssets
            ? { ...(assets === undefined ? {} : { binding: assets.binding }), directory: `./${CELLD_RELEASE_ASSETS_DIRECTORY}`, ...options.assetsConfig }
            : undefined,
        d1_databases: ofType(manifest, "d1").map((requirement) => {
            const name = releaseResourceName(alias, requirement.binding);

            return { binding: requirement.binding, database_id: name, database_name: name };
        }),
        durable_objects:
            durableObjects.length === 0
                ? undefined
                : {
                      bindings: durableObjects.map((requirement) => {
                          return { class_name: requirement.className, name: requirement.binding };
                      }),
                  },
        kv_namespaces: ofType(manifest, "kv").map((requirement) => {
            return { binding: requirement.binding, id: releaseResourceName(alias, requirement.binding) };
        }),
        migrations: sqliteClasses.length === 0 ? [] : [{ new_sqlite_classes: sqliteClasses, tag: MIGRATION_TAG }],
        queues: queueSection(alias, manifest),
        r2_buckets: ofType(manifest, "r2").map((requirement) => {
            return {
                binding: requirement.binding,
                bucket_name: releaseResourceName(alias, requirement.binding),
            };
        }),
        workflows: ofType(manifest, "workflow").map((requirement) => {
            return { binding: requirement.binding, class_name: requirement.className, name: requirement.resource ?? requirement.binding };
        }),
    };

    // Configures nothing → left out, so the config shows only what the Worker uses.
    return Object.fromEntries(Object.entries(sections).filter(([, value]) => value !== undefined && !(Array.isArray(value) && value.length === 0)));
};

/**
 * The Wrangler config celld deploys a stored release with — written beside
 * the bundle ({@link CELLD_RELEASE_MAIN}) and the assets
 * ({@link CELLD_RELEASE_ASSETS_DIRECTORY}) in the release directory.
 * @param manifest the release's binding manifest
 * @returns a config holding only keys celld accepts
 * @throws {CelldReleaseConfigError} listing every binding celld cannot run, or
 * for a malformed alias, an over-long resource name, or assets that do not
 * match the manifest's assets binding.
 */
const celldConfigFromRelease = (manifest: CelldReleaseManifest, options: CelldReleaseOptions): Config => {
    const refused = manifest.bindings.flatMap((requirement) => {
        const reason = refusalOf(requirement);

        return reason === undefined ? [] : [{ binding: requirement.binding, reason, type: requirement.type }];
    });

    if (refused.length > 0) {
        throw new CelldReleaseConfigError(
            `this release cannot run on celld: ${refused.map((entry) => `${entry.binding} (${entry.type}): ${entry.reason}`).join("; ")}`,
            refused,
        );
    }

    const hasAssetsBinding = manifest.bindings.some((requirement) => requirement.type === "assets");

    if (hasAssetsBinding !== options.hasAssets) {
        throw new CelldReleaseConfigError(
            options.hasAssets
                ? "the release carries assets but its manifest has no assets binding"
                : "the manifest has an assets binding but the release carries no assets",
        );
    }

    const compatibilityDate = options.compatibilityDate ?? manifest.compatibilityDate;
    const config: Config = {
        name: options.alias,
        main: CELLD_RELEASE_MAIN,
        no_bundle: true,
        ...(compatibilityDate === undefined ? {} : { compatibility_date: compatibilityDate }),
        compatibility_flags: [...(options.compatibilityFlags ?? manifest.compatibilityFlags ?? DEFAULT_COMPATIBILITY_FLAGS)],
        ...(Object.keys(options.vars).length === 0 ? {} : { vars: { ...options.vars } }),
        ...(options.crons.length === 0 ? {} : { triggers: { crons: [...options.crons] } }),
        ...bindingSections(options.alias, manifest, options),
    };

    // The shared projection is the last word on what celld accepts; a key it
    // drops here is a bug in this function, never something to ship silently.
    const { config: projected, dropped } = projectCelldConfig(config);

    if (dropped.length > 0) {
        throw new CelldReleaseConfigError(`celld would refuse ${dropped.join(", ")}`);
    }

    return projected;
};

export type { CelldReleaseAssetsConfig, CelldReleaseManifest, CelldReleaseOptions, CelldReleaseRefusal };
export {
    CELLD_RELEASE_ASSETS_DIRECTORY,
    CELLD_RELEASE_BINDING_TYPES,
    CELLD_RELEASE_MAIN,
    celldConfigFromRelease,
    CelldReleaseConfigError,
    releaseResourceName,
};
