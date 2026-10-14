import emit from "../finding";
import type { Category, Facing, Finding, Level, Lint, LintContext } from "../types";

/**
 * Static metadata + per-occurrence templates for one "arg-derived sink" lint —
 * a lint that flags a `ctx.<binding>` call whose key/URL/namespace argument is
 * derived from the handler's `args` with no server-side scoping. Every such
 * lint shares one shape: read one `context.<x>Accesses` evidence array (`undefined`
 * means "no static evidence, flag nothing"), then emit one {@link Finding} per
 * row via {@link emit}.
 */
export interface ArgumentDerivedSinkLintConfig<Access> {
    /** `access` row → the {@link Finding.metadata}-and-detail-agnostic cache key. */
    cacheKey: (access: Access) => string;
    /** Concern buckets every finding from this lint carries. */
    categories: Category[];
    /** General-purpose description shared by every finding. */
    description: string;
    /** `access` row → the per-occurrence violation message. */
    detail: (access: Access) => string;
    /** Default audience for this lint's findings. */
    facing: Facing;
    /** `context` → this binding's evidence array, or `undefined` when the codegen feeder supplied none. */
    getAccesses: (context: LintContext) => ReadonlyArray<Access> | undefined;
    /** Default severity for this lint's findings. */
    level: Level;
    /** `access` row → the structured {@link Finding.metadata}. */
    metadata: (access: Access) => Record<string, unknown>;
    /** Unique lint id, snake_case (e.g. `kv_unscoped_user_key_idor`). */
    name: string;
    /** Fix guidance shared by every finding. */
    remediation: string;

    /**
     * Extra suppression gate checked once per `run`, after evidence is known
     * to exist: when it returns `true`, every finding is withheld (e.g.
     * `browser_user_url_without_allowlist` suppresses all findings when a
     * hardened `createBrowser` config call is visible). Omit when a binding has
     * no such cross-referenced hardening signal.
     */
    suppressWhen?: (context: LintContext) => boolean;
    /** Short headline shared by every finding. */
    title: string;
}

/**
 * Build the `Lint` for one "arg-derived sink" binding (`ctx.kv`,
 * `ctx.containers.*.get`, `ctx.vectors`, `ctx.storage.*`, `ctx.browser`, the
 * image-delivery-URL builder, …) from {@link ArgumentDerivedSinkLintConfig}: read
 * `config.getAccesses(context)`, and — unless `undefined` or
 * `config.suppressWhen` withholds it — emit one finding per row using
 * `config.cacheKey` / `config.detail` / `config.metadata`.
 */
export const makeArgumentDerivedSinkLint = <Access>(config: ArgumentDerivedSinkLintConfig<Access>): Lint => {
    const lint: Lint = {
        categories: config.categories,
        description: config.description,
        facing: config.facing,
        level: config.level,
        name: config.name,
        remediation: config.remediation,
        run: (context) => {
            const accesses = config.getAccesses(context);

            if (accesses === undefined || config.suppressWhen?.(context) === true) {
                return [];
            }

            return accesses.map((access) =>
                emit(lint, {
                    cacheKey: config.cacheKey(access),
                    detail: config.detail(access),
                    metadata: config.metadata(access),
                }),
            );
        },
        source: "static",
        title: config.title,
    };

    return lint;
};
