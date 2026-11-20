/**
 * The pure half of `@lunora/config/celld`: the alias grammar, the per-project
 * resource names and the binding types a celld fleet runs. Nothing here touches
 * the filesystem, so a browser bundle can import it. `apps/cloud`'s provision
 * contract reads it on the client, and `@lunora/config/celld` itself pulls in
 * `node:fs` through the config projection, which such a bundle cannot load.
 */
import type { BindingRequirement } from "../cloudflare/binding-manifest";

/** One binding celld cannot run, and why. */
export interface CelldReleaseRefusal {
    binding: string;
    reason: string;
    type: BindingRequirement["type"];
}

/** Thrown when a release cannot run on celld; {@link CelldReleaseConfigError.refused} lists every binding at fault. */
export class CelldReleaseConfigError extends Error {
    public readonly refused: ReadonlyArray<CelldReleaseRefusal>;

    public constructor(message: string, refused: ReadonlyArray<CelldReleaseRefusal> = []) {
        super(message);
        this.name = "CelldReleaseConfigError";
        this.refused = refused;
    }
}

/**
 * The binding types a celld fleet runs, and so a release may carry, with how
 * each is satisfied: `provisioned` — a per-project resource this config names
 * ({@link releaseResourceName}); `bound` — bound as the manifest declares it.
 * Every other type is refused. The control plane's `celld-vps` binding row is
 * built from this map.
 */
export interface CelldReleaseBindings {
    readonly assets: "bound";
    readonly d1: "provisioned";
    readonly durable_object: "bound";
    readonly kv: "provisioned";
    readonly queue_consumer: "bound";
    readonly queue_producer: "provisioned";
    readonly r2: "provisioned";
    readonly workflow: "bound";
}

/** {@link CelldReleaseBindings} as a value. */
export const CELLD_RELEASE_BINDINGS: CelldReleaseBindings = {
    assets: "bound",
    d1: "provisioned",
    durable_object: "bound",
    kv: "provisioned",
    queue_consumer: "bound",
    queue_producer: "provisioned",
    r2: "provisioned",
    workflow: "bound",
};

/** The binding types celld runs ({@link CELLD_RELEASE_BINDINGS}' keys). */
export const CELLD_RELEASE_BINDING_TYPES: ReadonlySet<BindingRequirement["type"]> = new Set(
    Object.keys(CELLD_RELEASE_BINDINGS) as BindingRequirement["type"][],
);

/** One DNS label: dash-separated runs of `[a-z0-9]` — the alias rule of every target. */
export const RELEASE_ALIAS_PATTERN: RegExp = /^[a-z\d]+(?:-[a-z\d]+)*$/u;

/** Longest alias: one DNS label. */
export const MAX_RELEASE_ALIAS_LENGTH = 63;

/** The tightest name limit across the named resource types (R2 buckets, queues). */
export const MAX_RESOURCE_NAME = 63;

/** Whether `alias` is a deployment alias: one DNS label of dash-separated `[a-z0-9]` runs, at most 63 characters. */
export const isReleaseAlias = (alias: string): boolean => alias.length <= MAX_RELEASE_ALIAS_LENGTH && RELEASE_ALIAS_PATTERN.test(alias);

/**
 * The per-project name of a D1 database, KV namespace, R2 bucket or queue:
 * `{alias}--{binding}`, the binding lowercased with `_` → `-`. Injective, since an
 * alias never contains `--`; `apps/cloud`'s `tenantResourceName` names every
 * target's resources with it.
 * @throws {CelldReleaseConfigError} when the alias is malformed or the name is over 63 characters.
 */
export const releaseResourceName = (alias: string, binding: string): string => {
    if (!isReleaseAlias(alias)) {
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
