/**
 * The Cloudflare `version_metadata` binding, read in one place. It is an object
 * (`{ id, tag, timestamp }`), not a string var, so reading it needs a
 * `typeof … === "object"` walk rather than a plain env lookup.
 *
 * Bundler-inlined by relative path (see AGENTS.md "Top-level shared/"); keep it
 * zero-dependency.
 */

/** The binding name the `lunora init` templates declare `version_metadata` under. */
const VERSION_METADATA_BINDING = "CF_VERSION_METADATA";

/** Read a non-empty string property off a loosely-typed object (a binding, `request.cf`, …). */
const stringProperty = (object: unknown, key: string): string | undefined => {
    if (typeof object !== "object" || object === null) {
        return undefined;
    }

    const value = (object as Record<string, unknown>)[key];

    return typeof value === "string" && value.length > 0 ? value : undefined;
};

/**
 * The running Worker version's `id`, or `undefined` when `env` is not an object,
 * the binding is not declared, or it carries no non-empty id.
 *
 * The `id`, never the `tag`: a tag is user-set, optional and may be reused across
 * uploads, so anything that must change on every deploy keys on the id.
 */
const workerVersionId = (env: unknown): string | undefined => {
    if (typeof env !== "object" || env === null) {
        return undefined;
    }

    return stringProperty((env as Record<string, unknown>)[VERSION_METADATA_BINDING], "id");
};

export { stringProperty, VERSION_METADATA_BINDING, workerVersionId };
